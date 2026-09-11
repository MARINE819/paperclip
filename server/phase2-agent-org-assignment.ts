import { createDb } from '@paperclipai/db';
import { sql } from 'drizzle-orm';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

const COMPANY_ID = '0a7f03e0-98b9-4e03-bd7b-be0d388025b7';
const DB_URL = 'postgres://paperclip:paperclip@127.0.0.1:54329/paperclip';
const INSTANCES_ROOT = String.raw`C:\Users\Nexora\.paperclip\instances\default`;

const CONSTITUTION_PATH = path.join(INSTANCES_ROOT, 'companies', COMPANY_ID, 'CONSTITUTION.md');

const getAgentDir = (agentId: string) => {
  return path.join(INSTANCES_ROOT, 'companies', COMPANY_ID, 'agents', agentId, 'instructions');
};

const getHash = (content: string) => {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
};

// Fixed legacy and new agent IDs
const JARVIS_ID = '136dfad5-78fa-4f56-a918-4eaa17ba2f20';
const PM_ID = 'de931e4c-62c3-435a-8e3d-84794edb1fd8'; // 윤지우 (Task Workflow Architect)
const QRA_ID = '3bee99b5-023a-492d-b1e8-88a961f7d8d1'; // 정태오 (Quality & Review Agent)

const NEW_AGENTS_IDS = {
  이유진: 'f189ef70-41bc-4d39-bb8d-cfd739798ef5',
  강건: 'd6ace3e7-60b6-4f8a-9392-e562e5a1c43d',
  최수아: '4eea4f3b-0cdd-4402-8d79-7b7a111e4a40',
  오승민: '6d259425-7ed9-4f91-bc16-b880fcc05211',
  백지수: '528bfd19-7de3-4e84-a9bf-3cee7b7d5d62',
  박준혁: 'fad5ec7c-abf4-4b82-aba9-258de2cf0a80',
  임도현: 'd4faa385-4e2a-4994-bd97-a3e5b1ed335b',
};

const NEW_AGENTS_DATA = [
  {
    name: '이유진',
    orgName: '비서실',
    title: '비서실장',
    rank: '책임급',
    reportsTo: null,
    roleText: `# 역할
귀하는 NEXORA의 비서실장 이유진입니다. 비서실을 총괄하며, Human CEO 서대곤 및 AI CoS JARVIS를 보좌하고 조직의 원활한 소통을 지원합니다.

# 책임
- 비서실 운영 총괄 및 에이전트 지원 업무 조율.
- CEO 직속 지시 사항 전파 및 일정/일지 관리.

# 경계
독자적인 시스템 수정이나 DB 변경 권한을 가지지 않으며, 모든 consequential action은 Human CEO 서대곤의 최종 결재를 득한 후 실행합니다.`
  },
  {
    name: '강건',
    orgName: '개발팀',
    title: '개발팀장',
    rank: '책임급',
    reportsTo: JARVIS_ID,
    roleText: `# 역할
귀하는 NEXORA의 개발팀장 강건입니다. 개발팀을 총괄하며, 시스템 개발, 아키텍처 설계 및 스키마 관리를 담당합니다.

# 책임
- 개발팀의 기술적 방향성 조율 및 코드 품질 관리.
- 마이그레이션 및 스키마 스펙 검토.

# 경계
운영 DB에 파괴적인 DDL을 직접 실행하지 않으며, 모든 마이그레이션은 QA 검증 및 Human CEO 결재 후 수행합니다.`
  },
  {
    name: '최수아',
    orgName: '개발팀',
    title: '개발팀원',
    rank: '실무급',
    reportsTo: NEW_AGENTS_IDS.강건,
    roleText: `# 역할
귀하는 NEXORA의 개발팀원 최수아입니다. 시스템 구현, 기능 개발 및 버그 수정을 담당합니다.

# 책임
- 개발팀장 강건의 지도하에 기능 개발 및 단위 테스트 작성.
- 코드베이스 개선 및 유지보수.

# 경계
직접적인 운영 배포 권한이 없으며, 모든 코드는 개발팀장 강건의 리뷰 및 승인을 거쳐야 합니다.`
  },
  {
    name: '오승민',
    orgName: '운영·인프라팀',
    title: '운영·인프라팀장',
    rank: '책임급',
    reportsTo: JARVIS_ID,
    roleText: `# 역할
귀하는 NEXORA의 운영·인프라팀장 오승민입니다. 인프라 운영, 백업 스케줄 관리 및 장애 물리 차단(Guard)을 담당합니다.

# 책임
- 서버 가동 상태 감시 및 백업본 안정성 관리.
- 시스템감시·감사팀의 고위험 경보 수신 시 장애 차단 조치 실행.

# 경계
Human CEO 승인 없이 인프라 사양을 임의 변경하거나 백업본을 복원(Restore)하지 않습니다.`
  },
  {
    name: '백지수',
    orgName: '지식·문서팀',
    title: '지식·문서팀장',
    rank: '선임급',
    reportsTo: JARVIS_ID,
    roleText: `# 역할
귀하는 NEXORA의 지식·문서팀장 백지수입니다. 지식 관리(Durable Knowledge Base) 보존 및 문서 인덱싱을 담당합니다.

# 책임
- 회사 지식 베이스의 체계적 보존 및 최신성 유지.
- 문서 및 지침 아카이브 인덱싱.

# 경계
공식 지침 변경은 임의로 수행하지 않으며, 반드시 승인된 프로세스(거버넌스)를 거친 문서만 배포합니다.`
  },
  {
    name: '박준혁',
    orgName: '보안팀',
    title: '보안팀장',
    rank: '책임급',
    reportsTo: JARVIS_ID,
    roleText: `# 역할
귀하는 NEXORA의 보안팀장 박준혁입니다. 권한 한계 검증 및 샌드박스 정책 통제를 담당합니다.

# 책임
- 에이전트 권한 정책 설계 및 샌드박스 보안 통제.
- 비정상적인 권한 남용이나 샌드박스 우회 시도 검사.

# 경계
시스템감시·감사팀 임도현과 협력하여 보안 경보를 수신하되, 예외 없는 보안 통제를 위해 JARVIS나 타 에이전트에 종속되지 않고 규정을 엄격히 적용합니다.`
  },
  {
    name: '임도현',
    orgName: '시스템감시·감사팀',
    title: '시스템감시·감사팀장',
    rank: '책임급',
    reportsTo: JARVIS_ID,
    roleText: `# 역할
귀하는 NEXORA의 시스템감시·감사팀장 임도현입니다. 예외 없는 Read-Only 원칙하에 시스템 무결성 감시 및 이상 징후 경보를 전담합니다.

# 책임
- 5초 주기 DB 연결 및 핵심 ID 모니터링, 실시간 파괴적 명령 실행시도(Pre-execution) 감시.
- 이상 징후 감지 시 증거 데이터 수집 및 JARVIS와 Human CEO 서대곤에게 동시 직속 경보 전송.

# 경계
예외 없이 Read-Only 검사만 수행하며, 운영 DB에 어떠한 쓰기 조작도 유발하지 않습니다. 자동 삭제, 프로세스 중지 등의 제어 조치는 직접 수행하지 않고 운영·인프라팀에 위임합니다.`
  }
];

type PreparedFile = {
  tmpPath: string;
  finalPath: string;
  expectedHash: string;
};

type PublishedFile = PreparedFile & {
  backupPath: string;
  hadOriginal: boolean;
};

const cleanupPreparedFiles = (files: PreparedFile[]) => {
  for (const file of files) {
    if (fs.existsSync(file.tmpPath)) fs.unlinkSync(file.tmpPath);
  }
};

const restorePublishedFiles = (files: PublishedFile[]) => {
  for (const file of [...files].reverse()) {
    if (fs.existsSync(file.finalPath)) fs.unlinkSync(file.finalPath);
    if (file.hadOriginal && fs.existsSync(file.backupPath)) {
      fs.renameSync(file.backupPath, file.finalPath);
    }
  }
};

async function main() {
  const db = createDb(DB_URL);

  // 1. Check the fixed Phase 2 identities before evaluating any other prerequisite.
  console.log('Checking for existing new agents...');
  const namesToCheck = Object.keys(NEW_AGENTS_IDS);
  const idsToCheck = Object.values(NEW_AGENTS_IDS);
  const existingNewAgents = await db.execute(sql`
    SELECT id, name
    FROM agents
    WHERE company_id = ${COMPANY_ID}
      AND (
        name IN (${namesToCheck[0]}, ${namesToCheck[1]}, ${namesToCheck[2]}, ${namesToCheck[3]}, ${namesToCheck[4]}, ${namesToCheck[5]}, ${namesToCheck[6]})
        OR id IN (${idsToCheck[0]}, ${idsToCheck[1]}, ${idsToCheck[2]}, ${idsToCheck[3]}, ${idsToCheck[4]}, ${idsToCheck[5]}, ${idsToCheck[6]})
      )
  `);

  const expectedIdentityPairs = new Set(
    Object.entries(NEW_AGENTS_IDS).map(([name, id]) => `${id}:${name}`),
  );
  const actualIdentityPairs = new Set(
    existingNewAgents.map((agent) => `${String(agent.id)}:${String(agent.name)}`),
  );
  const allExpectedAgentsExist =
    existingNewAgents.length === expectedIdentityPairs.size &&
    [...expectedIdentityPairs].every((identity) => actualIdentityPairs.has(identity));

  if (allExpectedAgentsExist) {
    console.log('==================================================');
    console.log('STATUS: ALREADY_APPLIED');
    console.log('All 7 new agents already exist with their fixed identities. Exiting safely.');
    console.log('==================================================');
    return;
  }

  if (existingNewAgents.length > 0) {
    console.error('==================================================');
    console.error('STATUS: PARTIAL_STATE (FAIL-CLOSED)');
    console.error(
      `${existingNewAgents.length} Phase 2 name/ID footprint(s) exist, but the complete fixed identity set does not match. Aborting.`,
    );
    console.error('==================================================');
    throw new Error('[PARTIAL_STATE] Phase 2 agent identities are incomplete or mismatched.');
  }

  console.log('Identity check passed. Proceeding with initial Phase 2 setup...');

  const legacyAgentIds = [JARVIS_ID, PM_ID, QRA_ID];
  const existingLegacyAgents = await db.execute(sql`
    SELECT id
    FROM agents
    WHERE company_id = ${COMPANY_ID}
      AND id IN (${legacyAgentIds[0]}, ${legacyAgentIds[1]}, ${legacyAgentIds[2]})
  `);
  const existingLegacyIds = new Set(existingLegacyAgents.map((agent) => String(agent.id)));
  if (!legacyAgentIds.every((id) => existingLegacyIds.has(id))) {
    throw new Error('[FAIL-CLOSED] One or more legacy agent identities are missing. Aborting to preserve history.');
  }

  // 2. Verify org_units count === 13
  console.log('Verifying org_units count...');
  const orgsResult = await db.execute(sql`SELECT id, name FROM org_units WHERE company_id = ${COMPANY_ID}`);
  if (orgsResult.length !== 13) {
    throw new Error(`[FAIL-CLOSED] Expected 13 org_units, found ${orgsResult.length}. Aborting.`);
  }
  console.log(`[PASS] Verified 13 org_units in database.`);

  const orgMap = new Map<string, string>();
  for (const org of orgsResult) {
    orgMap.set(org.name as string, org.id as string);
  }

  // Load constitution
  if (!fs.existsSync(CONSTITUTION_PATH)) {
    throw new Error(`Constitution not found at ${CONSTITUTION_PATH}`);
  }
  const constitutionContent = fs.readFileSync(CONSTITUTION_PATH, 'utf8');
  const constitutionHash = getHash(constitutionContent);

  // 3. Prepare filesystem changes atomically in temporary files
  console.log('Preparing instructions files atomically...');
  const filesToRename: PreparedFile[] = [];

  const prepareFilesystem = (agentId: string, roleText: string) => {
    const agentDir = getAgentDir(agentId);
    fs.mkdirSync(agentDir, { recursive: true });

    const tmpRolePath = path.join(agentDir, '.ROLE.md.phase2.tmp');
    const finalRolePath = path.join(agentDir, 'ROLE.md');
    const roleHash = getHash(roleText);
    filesToRename.push({ tmpPath: tmpRolePath, finalPath: finalRolePath, expectedHash: roleHash });
    fs.writeFileSync(tmpRolePath, roleText, { encoding: 'utf8', flag: 'wx' });
    if (getHash(fs.readFileSync(tmpRolePath, 'utf8')) !== roleHash) {
      throw new Error(`ROLE.md temp-file verification failed for agent: ${agentId}`);
    }

    const mergedContent = `<!-- 
======================================================================
[WARNING] DO NOT EDIT THIS FILE DIRECTLY.
This file was automatically generated by the constitution sync manager.
Constitution Version: 1.0.0
Constitution Hash: ${constitutionHash}
Generated Timestamp: ${new Date().toISOString()}
Role Source: ROLE.md
======================================================================
-->

${roleText}

${constitutionContent}`;

    const tmpAgentsPath = path.join(agentDir, '.AGENTS.md.phase2.tmp');
    const finalAgentsPath = path.join(agentDir, 'AGENTS.md');
    const agentsHash = getHash(mergedContent);
    filesToRename.push({ tmpPath: tmpAgentsPath, finalPath: finalAgentsPath, expectedHash: agentsHash });
    fs.writeFileSync(tmpAgentsPath, mergedContent, { encoding: 'utf8', flag: 'wx' });

    // Validate tmp hash
    const match = mergedContent.match(/Constitution Hash:\s*([a-f0-9]{64})/);
    if (!match || match[1] !== constitutionHash) {
      throw new Error(`Hash mismatch validation failed for prepared agent directory: ${agentId}`);
    }
    if (getHash(fs.readFileSync(tmpAgentsPath, 'utf8')) !== agentsHash) {
      throw new Error(`AGENTS.md temp-file verification failed for agent: ${agentId}`);
    }
  };

  try {
    // Prepare JARVIS files
    const jarvisBackupPath = path.join(INSTANCES_ROOT, '..', 'recovery', 'backups_agents', 'JARVIS_AGENTS.md');
    const jarvisBackup = fs.readFileSync(jarvisBackupPath, 'utf8');
    const jarvisRole = jarvisBackup.split(/\r?\n/).slice(0, 55).join('\n');
    prepareFilesystem(JARVIS_ID, jarvisRole);

    // Prepare 윤지우 (PM) files
    const pmRoleText = `# 역할
귀하는 NEXORA의 기획·전략팀장 윤지우입니다. 기존 Task Workflow Architect의 역할을 승계하여 모든 업무의 구조와 계획을 설계하고, 이슈의 범위를 정의하며, 인수 조건을 설계하는 역할을 수행합니다.

# 책임
- intake 접수, 범위 정의, acceptance criteria, handoff, 리스크 평가, 계획 설계, escalation 경로, scorecard를 정의합니다.
- 각 에이전트가 수행할 task-delivery workflow를 설계합니다.
- 기존 에이전트로 해결하기 어려운 업무 구조를 상세히 정의합니다.
- 불필요한 에이전트 생성은 차단합니다.

# 경계
허가되지 않은 외부 API 호출이나 계약, 비용 지출 등 consequential action을 직접 수행하지 않습니다. 최종 승인은 오직 Human CEO(Board)를 통해서만 진행하며, JARVIS의 최종 결정에 맹목적으로 의존하지 않고 독립적으로 흐름을 분석합니다.`;
    prepareFilesystem(PM_ID, pmRoleText);

    // Prepare 정태오 (QRA) files
    const qraRoleText = `# 역할
귀하는 NEXORA의 QA·품질팀장 정태오입니다. 기존 Quality & Review Agent의 역할을 승계하여 task-delivery 과정의 결과물이 기준을 충족하는지 독립적이고 엄격하게 검증하는 역할을 수행합니다.

# 책임
- 완료된 결과물의 workflow specification, task evidence, auditability, scorecard를 검증합니다.
- 검증 결과에 따라 작업을 repeat, adjust, stop 하도록 요구할 권한을 가집니다.
- 결과물이 사전에 정의된 acceptance criteria를 완벽히 충족하는지 확인합니다.
- 모든 검증 과정의 증거를 철저히 기록합니다.

# 경계
직접 업무를 수행하여 결과를 만들어내지 않으며, 오직 독립적인 검증만 수행합니다. JARVIS의 지시나 의견에 맹목적으로 순응하지 않고 독자적으로 합의점을 도출합니다. 검증 시 예외를 허용하지 않습니다.`;
    prepareFilesystem(QRA_ID, qraRoleText);

    // Prepare new agents files
    for (const newAgent of NEW_AGENTS_DATA) {
      const id = NEW_AGENTS_IDS[newAgent.name as keyof typeof NEW_AGENTS_IDS];
      if (!id) throw new Error(`ID placeholder missing for ${newAgent.name}`);
      prepareFilesystem(id, newAgent.roleText);
    }
  } catch (err) {
    // Clean up tmp files and throw
    cleanupPreparedFiles(filesToRename);
    throw err;
  }

  // 4. Keep the DB transaction open until every verified temp file has been
  // atomically published. A filesystem failure therefore occurs before commit.
  console.log('Starting DB Transaction...');
  const publishedFiles: PublishedFile[] = [];
  try {
    await db.transaction(async (tx) => {
      // (1) Update existing agents
      await tx.execute(sql`
        UPDATE agents 
        SET title = 'AI Chief of Staff / Orchestrator', rank = '수석급', reports_to = NULL, org_unit_id = NULL, updated_at = NOW()
        WHERE id = ${JARVIS_ID} AND company_id = ${COMPANY_ID}
      `);

      const pmOrgId = orgMap.get('기획·전략팀');
      if (!pmOrgId) throw new Error('기획·전략팀 org_unit not found');
      await tx.execute(sql`
        UPDATE agents 
        SET name = '윤지우', title = '기획·전략팀장', rank = '선임급', reports_to = ${JARVIS_ID}, org_unit_id = ${pmOrgId}, updated_at = NOW()
        WHERE id = ${PM_ID} AND company_id = ${COMPANY_ID}
      `);

      const qraOrgId = orgMap.get('QA·품질팀');
      if (!qraOrgId) throw new Error('QA·품질팀 org_unit not found');
      await tx.execute(sql`
        UPDATE agents 
        SET name = '정태오', title = 'QA·품질팀장', rank = '선임급', reports_to = ${JARVIS_ID}, org_unit_id = ${qraOrgId}, updated_at = NOW()
        WHERE id = ${QRA_ID} AND company_id = ${COMPANY_ID}
      `);

      // (2) Insert new agents
      for (const newAgent of NEW_AGENTS_DATA) {
        const id = NEW_AGENTS_IDS[newAgent.name as keyof typeof NEW_AGENTS_IDS];
        const orgUnitId = orgMap.get(newAgent.orgName);
        if (!orgUnitId) throw new Error(`Org unit ${newAgent.orgName} not found`);

        const adapterConfig = {
          search: false,
          fastMode: false,
          graceSec: 15,
          timeoutSec: 0,
          instructionsFilePath: path.join(getAgentDir(id), 'AGENTS.md'),
          instructionsRootPath: getAgentDir(id),
          instructionsEntryFile: 'AGENTS.md',
          instructionsBundleMode: 'managed',
          dangerouslyBypassApprovalsAndSandbox: false
        };

        const runtimeConfig = {
          heartbeat: {
            enabled: false,
            maxConcurrentRuns: 20
          },
          modelProfiles: {
            cheap: {
              enabled: false
            }
          }
        };

        const permissions = {
          trustPreset: "standard",
          canCreateAgents: false,
          canCreateSkills: false
        };

        await tx.execute(sql`
          INSERT INTO agents (
            id, company_id, name, role, title, status, reports_to, org_unit_id, rank,
            adapter_type, adapter_config, runtime_config, permissions, budget_monthly_cents, spent_monthly_cents, created_at, updated_at
          ) VALUES (
            ${id}, ${COMPANY_ID}, ${newAgent.name}, 'general', ${newAgent.title}, 'idle', ${newAgent.reportsTo}, ${orgUnitId}, ${newAgent.rank},
            'codex_local', ${JSON.stringify(adapterConfig)}, ${JSON.stringify(runtimeConfig)}, ${JSON.stringify(permissions)}, 0, 0, NOW(), NOW()
          )
        `);
      }

      for (const item of filesToRename) {
        const backupPath = `${item.finalPath}.phase2.bak`;
        if (fs.existsSync(backupPath)) {
          throw new Error(`Refusing to overwrite stale Phase 2 backup: ${backupPath}`);
        }

        const hadOriginal = fs.existsSync(item.finalPath);
        if (hadOriginal) fs.renameSync(item.finalPath, backupPath);

        try {
          fs.renameSync(item.tmpPath, item.finalPath);
          if (getHash(fs.readFileSync(item.finalPath, 'utf8')) !== item.expectedHash) {
            throw new Error(`Published-file verification failed: ${item.finalPath}`);
          }
          publishedFiles.push({ ...item, backupPath, hadOriginal });
        } catch (error) {
          if (fs.existsSync(item.finalPath)) fs.unlinkSync(item.finalPath);
          if (hadOriginal && fs.existsSync(backupPath)) fs.renameSync(backupPath, item.finalPath);
          throw error;
        }
      }
    });

    console.log('[PASS] Files published and DB transaction committed successfully.');
  } catch (dbErr) {
    console.error('[FAIL] Phase 2 transaction failed. Restoring files and cleaning up temp files...');
    restorePublishedFiles(publishedFiles);
    cleanupPreparedFiles(filesToRename);
    throw dbErr;
  }

  // Backup cleanup is deliberately outside the transaction failure handler:
  // once commit succeeds, a cleanup error must never restore pre-Phase-2 files.
  for (const item of publishedFiles) {
    if (!item.hadOriginal || !fs.existsSync(item.backupPath)) continue;
    try {
      fs.unlinkSync(item.backupPath);
    } catch (cleanupError) {
      console.warn(`[WARN] Committed successfully but could not remove backup ${item.backupPath}`, cleanupError);
    }
  }

  console.log('Phase 2 setup completed successfully.');
}

main().catch((err) => {
  console.error('Fatal error during Phase 2 setup:', err);
  process.exit(1);
});
