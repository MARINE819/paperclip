# NEXORA 1차 GitHub 저장 자동화

이 자동화는 역할을 두 부분으로 분리합니다.

1. AI 직원은 저장할 **정확한 파일 목록**으로 요청서를 준비합니다.
2. CEO는 전체 변경 내용을 확인하고 마지막에 대문자 `SAVE`를 입력합니다.

AI 직원은 `git-save.mjs`를 실행하거나 `SAVE`를 대신 입력하면 안 됩니다.

## 1. AI 직원: 저장 요청 준비

`git-save-request.example.json`을 참고하여 요청 JSON을 만듭니다. `approvedPaths`에는 이번 작업에 속하는 개별 파일만 적습니다. 폴더, 와일드카드, 저장소 밖 경로는 허용되지 않습니다.

다음 준비 명령을 실행합니다.

```powershell
node scripts/operations/git-save-prepare.mjs --request scratch/my-save-request.json
```

준비 프로그램은 다음을 자동으로 기록합니다.

- 현재 로컬·원격 기준 커밋
- 고정된 GitHub 주소와 `master` 브랜치
- 승인 파일만 반영한 Git tree 고정값
- 요청한 AI 직원과 저장 사유

이 단계에서는 스테이징, 커밋, 푸시를 하지 않습니다.

## 2. CEO: 검토 후 실제 저장

준비 프로그램이 마지막에 표시한 명령을 CEO가 직접 실행합니다.

```powershell
node scripts/operations/git-save.mjs --manifest "<준비된 manifest 경로>"
```

프로그램이 보여 주는 파일 목록, 테스트 결과, 전체 diff, 요청자와 사유를 확인합니다. 모두 맞을 때만 대문자 `SAVE`를 입력합니다.

요청 준비 후 파일 내용이 바뀌거나, 다른 직원이 먼저 커밋·푸시하거나, 승인되지 않은 파일이 스테이징되면 저장은 중단됩니다. 새 요청서와 새 승인이 필요합니다.

## 테스트의 의미

`git-save-self-test`는 저장 안전장치 자체를 검사합니다. 변경된 앱 기능의 테스트를 대신하지 않습니다. 앱 기능 검증이 필요한 작업은 별도로 관련 앱 테스트를 통과한 뒤 저장 요청을 준비해야 합니다.
