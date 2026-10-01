import type { StageKind, TuringRule } from '../shared/types.js';
import type { Db } from './db.js';

type RuleRow = Record<string, unknown>;

export function listRules(db: Db): TuringRule[] {
  return (db.prepare('SELECT * FROM rules ORDER BY created_at, id').all() as RuleRow[]).map(toRule);
}

export function resolveEffectiveRules(db: Db, projectId: string): TuringRule[] {
  const rules = (
    db
      .prepare("SELECT * FROM rules WHERE enabled = 1 AND (scope = 'global' OR project_id = ?)")
      .all(projectId) as RuleRow[]
  )
    .map(toRule)
    .sort((left, right) => {
      if (left.mandatory !== right.mandatory) return Number(right.mandatory) - Number(left.mandatory);
      if (left.scope !== right.scope) return left.scope === 'project' ? -1 : 1;
      if (left.priority !== right.priority) return right.priority - left.priority;
      return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
    });
  return rules;
}

export function rulesForStage(rules: TuringRule[], kind: StageKind): TuringRule[] {
  return rules.filter((rule) => rule.appliesTo.length === 0 || rule.appliesTo.includes(kind));
}

function toRule(row: RuleRow): TuringRule {
  let stageKinds: StageKind[] = [];
  try {
    const value = JSON.parse(String(row.stage_kinds_json ?? '[]')) as unknown;
    if (Array.isArray(value)) stageKinds = value as StageKind[];
  } catch {
    stageKinds = [];
  }
  return {
    id: String(row.id),
    scope: String(row.scope) as TuringRule['scope'],
    projectId: typeof row.project_id === 'string' ? row.project_id : null,
    name: String(row.name),
    description: String(row.description ?? ''),
    content: String(row.content),
    enabled: Boolean(row.enabled),
    priority: Number(row.priority),
    mandatory: Boolean(row.mandatory),
    appliesTo: stageKinds,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
