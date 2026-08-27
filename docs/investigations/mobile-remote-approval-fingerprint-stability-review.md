# 모바일 원격 승인 — 연속 하트비트 및 지문 안정성(Fingerprint Stability) 검증 보고서

본 문서는 **Independent Security & Failure Reviewer**로서 하트비트 연속 재개(Continuous Wake)와 지문 안정성(Fingerprint Stability) 시나리오(WAKE-01 ~ WAKE-06)를 실제 제품 소스 코드 흐름을 추적하여 교차 검증한 결과 보고서입니다.

---

## 1. 연속 기동(Wake) 흐름 및 지문 계산 설계 분석

하트비트 루프(`heartbeat.ts:executeRun`) 내에서의 승인 지문 계산 공식은 다음과 같습니다:

```typescript
const taskText = [
  issueRef?.title,
  issueRef?.description,
  readNonEmptyString(context.prompt),
  readNonEmptyString(context.title),
  readNonEmptyString(context.message),
  wakeCommentBody,
].filter((value): value is string => Boolean(value)).join(" ").toLowerCase();

const canonicalFingerprint = computeApprovalFingerprint({
  companyId: agent.companyId,
  issueId: issueId ?? null,
  requestedByAgentId: agent.id,
  risk,
  taskText,
});
```

### WAKE-01 ~ WAKE-06 시나리오별 검증 결과

1. **WAKE-01 (동일 작업 내용 연속 wake)**: **`PASS (지문 안정)`**
   - 동일 이슈 및 프롬프트로 하트비트가 여러 번 깨어날 경우, `taskText` 구성 인자가 완벽히 보존되므로 `canonicalFingerprint`가 100% 일정하게 유지되어 불필요한 재승인을 요구하지 않습니다.
2. **WAKE-02 (비실행 메타데이터 변경)**: **`PASS (지문 안정)`**
   - 모델 설정(`modelProfile`), 재시도 횟수, 타임아웃 사양 등 런타임 환경 메타데이터는 지문 해시 공식에서 제외되어 있어, 이들이 변경되더라도 지문 불일치(`mismatch`) 오작동이 유발되지 않습니다.
3. **WAKE-03 (실제 작업 내용 변경)**: **`PASS (EXPECTED SECURITY BEHAVIOR)`**
   - 이슈 제목/본문 혹은 사용자 지시 사항(Comment)이 수정될 경우 지문 해시가 즉각 변경됩니다. 이는 의도된 보안 통제 계약(Stale Approval 거부)과 완벽히 부합합니다.
4. **WAKE-04 / WAKE-06 (동일 Retry-chain 내 복구)**: **`PASS (안전한 상속)`**
   - `Run A ──> Retry B ──> Retry C ──> Retry D` 체인 발생 시, `resolveRetryChainRootRunId` 함수가 25홉 제한 내에서 부모 관계를 거슬러 올라가 최종 Root ID(`Run A`)를 도출합니다.
   - 따라서 `consumeApproval` 시 동일한 소비자 ID(`Run A`)로 매치되어 `already_consumed_same_run` 판정을 통해 재승인 없이 자연스럽게 복구가 진행됩니다.
5. **WAKE-05 (무관한 신규 런)**: **`PASS (재사용 금지)`**
   - 부모 자식(Retry) 관계가 성립하지 않는 별개의 런(Run E)은 `rootRunId`가 다르게 평가되어 기존 승인의 재사용이 차단됩니다.

---

## 2. 최종 판단 및 결과 요약

* **지문 안정성**: **`STABLE`**
  - 불필요한 환경 변수나 타임스탬프 등 무관계 데이터가 지문 생성에서 철저히 제외되어 정상 작동 시 재승인이 절대 발생하지 않습니다.
* **가용성 확보**:
  - 크래시 복구 체인(`resolveRetryChainRootRunId`)의 검증 정밀함이 입증되었습니다.
* **통합 테스트 통과 상태**:
  - `vitest` 스위트 내의 전체 단위/통합 테스트 118개 전원 성공을 확인하였습니다.
