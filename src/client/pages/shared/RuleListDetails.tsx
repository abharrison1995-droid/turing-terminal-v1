import type { TuringRule } from '../../../shared/types';
import { stageLabels } from './stageMeta';

export function RuleListDetails({ rules, title }: { rules: TuringRule[]; title: string }) {
  return (
    <details className="rule-snapshot">
      <summary>
        {title} <span>{rules.length}</span>
      </summary>
      {rules.length ? (
        <ol>
          {rules.map((rule) => (
            <li key={rule.id}>
              <strong>
                {rule.mandatory ? 'Mandatory' : 'Advisory'} · {rule.scope} · {rule.name}
              </strong>
              <p>{rule.content}</p>
              <small>
                Priority {rule.priority}
                {rule.appliesTo.length
                  ? ` · ${rule.appliesTo.map((kind) => stageLabels[kind]).join(', ')}`
                  : ' · all stages'}
              </small>
            </li>
          ))}
        </ol>
      ) : (
        <p>No rules were active for this run.</p>
      )}
    </details>
  );
}
