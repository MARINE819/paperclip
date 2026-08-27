# NEXORA 모바일 원격 승인 — 독립 보안 검증 및 실패 시나리오 공격 테스트 보고서

본 문서는 NEXORA의 **Independent Security & Failure Reviewer**로서 승인 수명주기 보안 설계(Approval Lifecycle Security) 및 마이그레이션 변경 사양을 독립적으로 감사하고, 코너 케이스 및 잠재적 취약점을 도출한 보안 심사 보고서입니다.

---

## 1. 발견한 위험 및 취약점 (Security Threats & Vulnerabilities)

### 🚨 [CRITICAL] 하트비트 크래시 및 재시도 시 원격 승인 영구 잠김 (Heartbeat Retry Lockout)
* **상황**: 하트비트 런(Run 1)이 기동되어 `consumeApproval` 호출을 성공하여 DB의 `consumed_at` 및 `consumed_by_run_id = 'Run 1'`을 채운 직후, 에이전트의 하트비트 프로세스가 예기치 않게 크래시(메모리 초과, 인프라 재기동 등)되었습니다.
* **위험**: 에이전트가 재기동되면서 실패한 작업을 복구하기 위해 새로운 런(Run 2)을 시작합니다. Run 2가 동일한 승인 ID에 대해 `consumeApproval`을 시도하면, `consumed_by_run_id`가 `'Run 1'`로 채워져 있으므로 `already_consumed_other_run` 판정을 받아 **실행이 즉시 거부(FAIL)**됩니다.
* **영향**: 일시적인 네트워크 순단이나 컨테이너 크래시 상황임에도 불구하고, 승인자는 방금 누른 승인 요청에 대해 **다시 승인을 눌러야 하는 무한 승인 요청 루프**에 빠집니다.
* **해결 제안**: `consumeApproval` 검증 시 직전 실패한 런의 `retryOfRunId` 관계를 추적하여 동일 트랜잭션 가계도에 속한 재시도 런(Run 2)은 예외적으로 동일한 소비자로 인정하도록 예외 규칙을 확장해야 합니다.

### ⚠️ [HIGH] DB 트랜잭션 롤백과 API 응답 간의 불일치 위험 (API Commit Mismatch)
* **상황**: 모바일에서 `POST /approvals/:id/approve` 요청을 보냈고, 백엔드 서비스 `resolveApproval` 내에서 UPDATE 쿼리는 성공했으나, 라우터 수준의 `heartbeat.wakeup` 호출 실패 또는 감사 로그(`logActivity`) 테이블 쓰기 실패로 인해 에러가 발생하여 트랜잭션이 중도 롤백되는 경우입니다.
* **위험**: 멱등성 테이블 `approval_action_idempotency_keys`에는 상태가 `reserved`로 남아 있거나 트랜잭션 롤백으로 지워졌으나, 모바일 클라이언트는 네트워크 지연/타임아웃으로 실패 응답을 받아 다시 요청을 전송하게 됩니다. 이때 트랜잭션 원자성이 보장되지 않는 외부 알림(웹훅, 푸시 알림)이 이미 발송되어 중복 알림이 발생할 수 있습니다.
* **해결 제안**: 데이터베이스 트랜잭션 블록 내에서 외부 부작용(Side-effects)이 발생하지 않도록, `heartbeat.wakeup` 및 로깅 처리는 반드시 DB 트랜잭션 커밋이 완결(Commit Success)된 직후에 후속 프로세스로 호출되도록 격리해야 합니다.

### 💬 [MEDIUM] UNKNOWN 위험 등급에 대한 느슨한 만료 정책 (UNKNOWN Risk TTL Weakness)
* **상황**: 현재 분류기(`classifyPreExecutionRisk`)는 `LOW | HIGH | UNKNOWN`만 판정하며, `UNKNOWN` 등급은 미정의된 위험 요소이므로 가장 강력한 가드 통제가 필요합니다.
* **위험**: 설계상 `UNKNOWN` 등급의 TTL을 HIGH와 동일한 15분으로 설정했습니다. 그러나 에이전트가 알 수 없는 미분류 작업을 수행하려고 할 때는 15분의 노출 시간도 길 수 있으며, 5분 이내에 처리되지 않으면 즉시 자동 파기되어 재분류를 유도하는 것이 보안 아키텍처 관점에서 더욱 안전합니다.

---

## 2. 현재 구현에서 안전한 부분 (Verified Secure Elements)

* **완벽한 TOCTOU(시간차 공격) 방지**:
  - `consumeApproval`과 `resolveApproval` 모두 단순 SELECT-and-UPDATE가 아닌 단일 SQL `UPDATE ... WHERE status = 'approved' AND consumed_at IS NULL` 문법을 사용합니다. DB 엔진 레벨의 로우 락(Row Lock)을 활용하므로 **Double Consume 및 경합 조건(Race Condition)이 원천 차단**됩니다.
* **안전한 지문 공식 (SHA-256 Fingerprint binding)**:
  - 지문 해시 생성 범위에 작업 텍스트(`taskText`)뿐 아니라 `companyId`, `issueId`, `requestedByAgentId`까지 정적 결합하여 타 에이전트의 승인 가로채기(Hijack)나 타 회사로의 승인 유출 공격이 원천적으로 불가능합니다.
* **멱등성 캐시 테이블 분리**:
  - `approval_action_idempotency_keys` 테이블이 `approvals` 본문 테이블과 완전히 정규화 분리되어 있어, 캐시 히트 검증 성능이 높고 승인 원본 데이터 유실 위험이 없습니다.

---

## 3. 마이그레이션(`0219`, `0220`) 안전성 및 순서 검토

* **기존 Pending 승인 자동 만료 소급 적용 (Safe Backfill)**:
  - `0219` 마이그레이션 파일 내의 `UPDATE "approvals" SET ... "expires_at" = "created_at" + interval '15 minutes'` 쿼리는 기존 시스템에 장기 방치되어 있던 미만료 승인들을 마이그레이션 즉시 일괄 만료시켜, 배포 시점에 발생할 수 있는 오래된 승인 자동 오작동을 차단합니다. 매우 안전합니다.
* **배포 및 순서 제약사항 (Critical Deployment Sequence)**:
  - **반드시 DB 마이그레이션을 애플리케이션 서버 코드 배포보다 먼저 수행해야 합니다.**
  - 만약 코드가 먼저 배포될 경우, `approvals` 테이블의 신규 컬럼(`expires_at`, `task_fingerprint` 등)을 쿼리하는 로직이 구동되면서 `column does not exist` 런타임 크래시가 발생해 전체 결결재가 영구 마비됩니다. 반면 마이그레이션이 먼저 적용되면 기존 버전의 코드는 신규 컬럼을 조회하지 않으므로 무결하게 정상 하방 호환됩니다.

---

## 4. 반드시 추가해야 할 테스트 (Proposed Test Cases)

기존 97개 테스트에 포함되지 않은 아래의 극한 상황 테스트 케이스 추가를 권고합니다:

```typescript
describe("Approval Safety Edge Cases", () => {
  it("CONC-01: 1ms 간격의 초고속 중복 승인 요청 시 정확히 1회만 처리되는가 (Double-tap prevention)", async () => {
    // 멱등성 키가 다른 동일 승인 ID에 대해 동시에 두 쿼리 날림 -> 하나는 200, 하나는 409 리턴 검증
  });

  it("CRASH-02: 하트비트 크래시 후 재기동 시 retryOfRunId 관계를 통해 승인이 정상 인지되는가", async () => {
    // consumed_by_run_id가 Run A인 상태에서 Run B(retry of Run A)가 consume 시도 시 통과 여부 검증
  });

  it("TTL-03: 만료 경계값(정확히 15분 00초)에서 밀리초 단위 만료 연산이 안정적으로 실패하는가", async () => {
    // Date.now() + 15 * 60 * 1000 시점에 정확히 410 Gone 반환 여부 검증
  });
});
```

---

## 5. Claude 통합안 검증 체크리스트 (Review Verification Checklist)

Claude가 제안하는 프론트엔드/백엔드 최종 통합 소스 코드 반영 시 반드시 아래 기준을 확인하십시오:

* [ ] `heartbeat.ts`의 승인 생성 시점에 지문 생성이 `computeApprovalFingerprint` 헬퍼 함수로 완전 일원화되었는가? (이중 계산으로 인한 지문 불일치 차단)
* [ ] 멱등성 캐시 테이블의 키 조회 시 `actor_identity`가 모바일 기기별 토큰 또는 웹 세션 세그먼트 단위로 명확하게 바인딩되었는가? (타 사용자 캐시 간섭 방지)
* [ ] `expiresAt` 계산에 사용되는 타임존이 PostgreSQL 서버 타임존 및 애플리케이션 UTC 타임존과 오차 없이 일치하는가?
* [ ] 모바일 UI 상에서 만료된 승인 건은 `effectiveStatus === 'expired'` 데이터를 기반으로 액션 버튼이 완벽하게 비활성화(`disabled`) 처리되는가?

---

## 6. 최종 판정 (Final Decision)

### **`PASS WITH CONDITIONS` (조건부 패스)**

* **판정 근거**: 동시성 경합 및 시간차 공격(TOCTOU)에 대한 DB 수준의 가드는 완벽하게 수립되어 안전하나, **하트비트 크래시 후 재시도(Retry Run) 시 기존 승인이 영구 Lock되는 가용성 이슈(Vulnerability-01)**와 **트랜잭션 롤백 시 알림 중복 부작용 발생 위험(Vulnerability-02)**을 해소해야 하므로 이를 보완하는 조건 하에 패스 판정을 내립니다.
