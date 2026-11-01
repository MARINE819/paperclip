# NEXORA — 평면형 2D 픽셀아트 AI Office 통합 구현 및 검증 보고서

- **작성일**: 2026-10-31
- **담당**: Antigravity (AI Office 프론트엔드 및 모바일 UX/UI)
- **기반 문서**: `C:\Obsidian\Physical AI\NEXORA\NEXORA Control Center.md` (§NEXORA AI Office — 최종 통합 설계 결정, 2026-10-31)

---

## 1. User Request

CEO가 2026-10-31 최종 확정한 **위에서 내려다보는 평면형(Top-Down) 2D 픽셀아트 사무실 + 어두운 통합 관제 대시보드** 설계에 따라 Step 1~4 프론트엔드 구현을 수행한다.

1. 위에서 내려다보는 단일 2D 픽셀아트 사무실과 기존 관제 대시보드를 통합한다(입체형 이중 개발 배제).
2. 현재 등록된 실제 AI 직원과 부서를 표시하고, 실제 업무 데이터에 연결된 9종 행동 애니메이션만 구현한다.
3. 신규 직원 채용 시 빈 좌석 자동 배정 및 신규 부서 추가 시 사무실 하단 자동 확장(상하 스크롤 탐색)을 지원한다.
4. PC·모바일 공통 화면(핀치 줌·화면 이동·상하 스크롤·구역 빠른 이동)과 기존 JARVIS 한국어 음성 기능을 연결한다.
5. 기존 승인·보안·비용·비상정지·상세 조회 기능을 보존하고 Claude Code 작업 영역과 충돌하지 않는다.

---

## 2. 왜 이 일을 하는지 쉬운 설명

기존 AI Office는 단순한 평면 카드 상자 나열 형태였고 직원별 고유 캐릭터나 실시간 행동 표현이 부족했습니다.
이번 구현을 통해 **실제 NEXORA의 업무·승인·위임·음성 지시 데이터가 위에서 내려다보는 하나의 2D 픽셀아트 사무실 도면 위에서 실시간으로 움직이도록 통합**하여, CEO가 PC와 휴대폰 어디서든 회사 전체 가동 상태를 직관적으로 지휘·관제할 수 있도록 개선했습니다.

---

## 3. 확인된 현재 상태 및 단계별 구현 결과 (Step 1 ~ Step 4)

### Step 1 — 평면형 2D 픽셀아트 사무실 도면 및 실제 직원·부서 배치
- [`TopDownOfficeCanvas.tsx`](../../ui/src/components/office-2d/TopDownOfficeCanvas.tsx) 및 [`PixelAgentSprite.tsx`](../../ui/src/components/office-2d/PixelAgentSprite.tsx)를 구현하여 [`AiOffice.tsx`](../../ui/src/pages/AiOffice.tsx)의 2D 오피스 뷰에 통합했습니다.
- **1구역(지휘 본부)**: `CEO실`(서대곤 CEO 고정석 + 결재 대기 배지), `JARVIS 워크스테이션`, `COO석`(Atlas 또는 정직한 공석 표시), `비서실`(이유진 비서실장)을 상단에 배치했습니다.
- **2구역(핵심 실무 부서)** 및 **3구역(협업 회의실·라운지)**, **4구역(전문·확장 부서)**: 중앙 가로 복도와 하단 확장 구역을 통해 모든 실제 부서와 직원이 누락 없이 표시되며, 미연결/미배정 부서는 가짜 캐릭터 없이 정직하게 표시됩니다.

### Step 2 — 실제 업무 데이터 기반 9종 행동 애니메이션 및 하단 자동 확장
- [`officeLayoutEngine.ts`](../../ui/src/components/office-2d/officeLayoutEngine.ts)의 `deriveAgentBehavior`를 통해 실제 데이터(`agent.status`, `liveRuns`, `allIssues`, `completedIssues`, `pendingApprovals`)로부터 9가지 행동을 결정론적으로 도출합니다:
  1. `idle` (대기)
  2. `task-assigned` (업무 배정)
  3. `moving-to-seat` (자리 이동 및 착석 — `queued` 실행 진입 시)
  4. `working-typing` (실제 업무 중 양손 키보드 타이핑 + 모니터 활성)
  5. `collaborating` (협업 및 회의 — 실제 부모·자식 이슈 공동 수행 및 `in_review` 연결 시 실시간 협업 배너 표시)
  6. `approval-waiting` (CEO 승인 대기 — 호박색 시계 표시등 + CEO실 결재 카운터 연동)
  7. `task-completed` (업무 완료 — 완료 체크 배지 후 대기 복귀)
  8. `blocked-error` (오류 및 차단 — 적색 경보 점멸)
  9. `offline` (오프라인 — 모니터 전원 꺼짐 및 반투명 절전 표시)
- `computeRoomCapacity`를 통해 부서 인원 증가 시 방 크기가 자동 확장(`sm:col-span-2`)되고, 신규 부서 추가 시 하단(`#office-zone-expansion`)으로 자동 연장되어 **상하 스크롤**로 탐색됩니다.

### Step 3 — PC·모바일 공통 화면 조작 및 JARVIS 한국어 음성 연동
- **PC·모바일 공통 조작**:
  - 상하·좌우 스크롤 뷰포트(`data-testid="ai-office-scroll-viewport"`), 단계별 확대/축소 버튼(`75% ~ 130%`), 모바일 두 손가락 핀치 줌(`onTouchStart`/`onTouchMove`), 구역 빠른 이동 칩(`지휘 본부`, `실무 부서`, `회의실·라운지`, `확장 부서`)을 구현했습니다.
- **JARVIS 한국어 음성 연동**:
  - [`VoiceCommandBar.tsx`](../../ui/src/components/VoiceCommandBar.tsx)의 한국어(`ko-KR`) 음성 인식 및 TTS(`speechSynthesis`) 결과 읽기 안내를 한국어로 보강하고, 음성 인식 중(`listening`/`processing`)일 때 평면 사무실의 **JARVIS 캐릭터에 실시간 마이크 수신 표시등과 상단 배너(`JARVIS 한국어 음성 수신 중`)**가 점등되도록 연결했습니다.
  - 기존 위험 명령 승인 조건(`isApprovalRequested`)과 보안 규칙은 100% 그대로 보존했습니다.

### Step 4 — 통합 대시보드 보존 및 정적·단위 테스트 설계 검증
- 우측 [`AIOfficeCeoControlRail`](../../ui/src/components/AIOfficeCeoControlRail.tsx), 클릭 시 열리는 [`AgentDetailSheet`](../../ui/src/components/AIOfficeFloor.tsx), [`AIOfficeWorkspaceSheet`](../../ui/src/components/AIOfficeWorkspaceSheet.tsx), 하단 Control Center 4대 탭(SRE/보안/지식/품질), 비용 카드, `Emergency Stop` 다이얼로그를 무손실 보존했습니다.
- 신규 단위·컴포넌트 테스트 파일 [`TopDownOfficeCanvas.test.tsx`](../../ui/src/components/office-2d/TopDownOfficeCanvas.test.tsx)를 작성하여 9종 행동 도출, 고유 픽셀 외형 시드, 방 자동 확장, 확대/축소, 협업 배너, 음성 수신 표시등을 검증하도록 구성했습니다.

---

## 4. 변경 파일 목록 (Antigravity 프론트엔드 범위 내)

### 신규 생성 파일 (4개)
1. `ui/src/components/office-2d/officeLayoutEngine.ts` — 9종 실제 행동 상태 도출, 직원 고유 픽셀 외형 시드, 부서 좌석·공간 자동 확장 계산 엔진
2. `ui/src/components/office-2d/PixelAgentSprite.tsx` — Paperclip 디자인 토큰(`--agent-*`, `--status-agent-*`) 기반 평면형 2D 픽셀 캐릭터 및 행동/음성 표시등
3. `ui/src/components/office-2d/TopDownOfficeCanvas.tsx` — 평면형 2D 픽셀아트 사무실 도면, 상하 스크롤/핀치 줌/구역 이동 툴바, 실시간 행동 요약 바, 협업 배너
4. `ui/src/components/office-2d/TopDownOfficeCanvas.test.tsx` — 평면형 2D 오피스 엔진·스프라이트·캔버스 단위 테스트

### 수정 파일 (3개)
5. `ui/src/components/AIOfficeFloor.tsx` — `MiniAgentFigure`에 `PixelAgentSprite` 연결, `RoomBox` 평면 방 출입문/근무 인원 배지/확장 속성 지원, `Workstation` 행동 상태 전달 (기존 테스트 셀렉터 및 DOM 구조 100% 유지)
6. `ui/src/pages/AiOffice.tsx` — 2D 오피스 뷰에 `TopDownOfficeCanvas` 연결 및 미사용 아이콘 import 정리 (기존 데이터 쿼리·WebSocket·관제 레일·시트·하단 탭 100% 보존)
7. `ui/src/components/VoiceCommandBar.tsx` — 한국어 음성 안내 및 iPhone/브라우저 HTTPS 제약 안내 문구 보강 (기존 `VoiceCommandBar.test.tsx`의 모든 영문 검증 문자열 100% 보존)

### 수정하지 않은 보호 영역
- `server/**`, `packages/db/**`, `packages/shared/**`, `tests/e2e/ai-office-realtime.spec.ts`, `C:\Obsidian\Physical AI\NEXORA\NEXORA Control Center.md`, `package.json` — **변경 0건**

---

## 5. 테스트 및 검증 결과 (정직한 검증 상태 보고)

### 5.1 정적 코드 및 디자인 토큰 게이트 검증 — **PASS (자체 정적 전수 대조 완료)**
- [`scripts/check-token-gates.mjs`](../../scripts/check-token-gates.mjs)의 4대 게이트 정규식 기준 전수 대조:
  - **Gate 1 (하드코딩 색상 리터럴 `#hex`, `rgb/hsl/oklch` 숫자 리터럴)**: 신규/수정 파일 전체 **0건 (CLEAN)**
  - **Gate 2 (임의 Tailwind 대괄호 유틸리티 `word-[...]`)**: 신규 `office-2d/*` 파일 전체 **0건 (CLEAN)**
  - **Gate 3 (원시 `fontSize` / `text-[Npx]` 선언)**: 신규 `office-2d/*` 파일 전체 **0건 (CLEAN)**
  - **금지 문자열 회귀 가드 (`"식물"`, `"구성"`)**: 전체 파일 **0건 (CLEAN)**
- 기존 테스트 호환성 대조:
  - `AIOfficeFloor.test.tsx`: `data-part="monitor" | "monitor-stand" | "desk" | "agent" | "chair"`, `w-36`, `w-28`, `w-14`, `h-6 w-6`, `PixelAgentSprite` 내부 텍스트 노드 0개 유지로 기존 `Workstation` 텍스트 검증과 100% 호환.
  - `VoiceCommandBar.test.tsx`: `"Voice input requires Chrome or Edge."`, `"Microphone permission is required."`, `"Approval requested"`, `"has not been paused"` 등 모든 기존 단언 문자열 보존.

### 5.2 터미널 명령(`run_command`) 실행 차단 보고 — **BLOCKED BY PRE-TOOL HOOK (실행 미수행 정직 보고)**
- 본 세션에서 `run_command` 도구 호출 시 환경의 pre-tool hook에 의해 다음 오류로 실행이 차단되었습니다:
  `tool call denied by pre-tool hook: Task scope environment not configured (ANTIGRAVITY_REPO_ROOT/ANTIGRAVITY_TASK_SCOPE_FILE missing).`
- 보안 지침에 따라 훅을 우회하지 않았으며, 따라서 터미널 명령어(`git status`, `pnpm --filter @paperclipai/ui typecheck`, `pnpm test`, `pnpm check:token-gates`, 브라우저 E2E)는 **이번 세션에서 직접 셸로 실행하지 못했습니다(NOT EXECUTED IN SHELL).**
- CEO 또는 터미널 환경에서 아래 명령으로 즉시 실행 검증하실 수 있습니다:
  ```sh
  node scripts/check-token-gates.mjs
  pnpm --filter @paperclipai/ui typecheck
  pnpm --filter @paperclipai/ui test -- src/components/office-2d/TopDownOfficeCanvas.test.tsx src/components/AIOfficeFloor.test.tsx src/components/VoiceCommandBar.test.tsx src/pages/AiOffice.test.tsx
  ```

---

## 6. 남은 작업

1. 터미널 환경(`ANTIGRAVITY_REPO_ROOT` / `ANTIGRAVITY_TASK_SCOPE_FILE` 설정 환경 또는 CEO 터미널)에서 위 Vitest 및 `check-token-gates.mjs` 실행 결과 최종 확인.
2. 실제 iPhone/Android 모바일 브라우저(HTTPS 보안 연결)에서 한국어 음성 인식(`VoiceCommandBar`) 및 핀치 줌 실기기 UAT 확인.

---

## 7. Human 결정 필요 사항

- 현재 구현된 프론트엔드 변경 세트를 CEO 터미널에서 테스트 실행 후 유지·반영할지 여부.

---

## 8. 적용하지 않은 작업과 이유

- **백엔드(`server/**`) 및 DB(`packages/db/**`) 수정 미적용**: Claude Code 담당 영역 보호 및 승인된 프론트엔드 범위 준수.
- **`tests/e2e/ai-office-realtime.spec.ts` 수정 미적용**: 작업 경계 지침에 따라 기존 E2E 파일과의 충돌을 피하기 위해 수정하지 않고 모든 기존 `data-testid`를 그대로 보존함.
- **셸 명령(`run_command`) 강제 우회 미시도**: 환경 pre-tool hook(`ANTIGRAVITY_REPO_ROOT/ANTIGRAVITY_TASK_SCOPE_FILE missing`) 차단을 우회하지 않고 정직하게 보고함.
