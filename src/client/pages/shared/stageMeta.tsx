import {
  Bell,
  CheckCircle2,
  FileCode2,
  GitBranch,
  GitCommitHorizontal,
  GitCompareArrows,
  LockKeyhole,
  RefreshCw,
  Scale,
  Search,
  Shield,
  Sparkles,
  TerminalSquare,
  type LucideIcon,
} from 'lucide-react';
import type { StageKind } from '../../../shared/types';

export const stageLabels: Record<StageKind, string> = {
  planner: 'Planner',
  promptRefinement: 'Prompt refinement',
  implementer: 'Implementer',
  build: 'Build',
  test: 'Test',
  reviewer: 'Reviewer',
  parallelReview: 'Parallel review',
  consolidate: 'Consolidation',
  orchestrator: 'AI Orchestrator',
  remediation: 'Remediation',
  finalGate: 'Final gate',
  gitCheckpoint: 'Git checkpoint',
  gitCommit: 'Git commit',
  gitPush: 'Git push',
  gitMerge: 'Git merge',
  gitRollback: 'Git rollback / restore',
  conditionalBranch: 'Conditional branch',
  shellCommand: 'Shell command',
  notification: 'Notification',
  humanApproval: 'Human approval',
  decisionGate: 'Decision Gate',
};

export function iconForStage(kind: StageKind): LucideIcon {
  return {
    planner: Sparkles,
    promptRefinement: Sparkles,
    implementer: FileCode2,
    build: TerminalSquare,
    test: CheckCircle2,
    reviewer: Search,
    parallelReview: Search,
    consolidate: GitCompareArrows,
    orchestrator: Sparkles,
    remediation: RefreshCw,
    finalGate: Shield,
    gitCheckpoint: GitCommitHorizontal,
    gitCommit: GitCommitHorizontal,
    gitPush: GitBranch,
    gitMerge: GitCompareArrows,
    gitRollback: RefreshCw,
    conditionalBranch: GitCompareArrows,
    shellCommand: TerminalSquare,
    notification: Bell,
    humanApproval: LockKeyhole,
    decisionGate: Scale,
  }[kind];
}

export function isAiStage(kind: StageKind): boolean {
  return [
    'planner',
    'promptRefinement',
    'implementer',
    'reviewer',
    'parallelReview',
    'consolidate',
    'orchestrator',
    'remediation',
    'finalGate',
  ].includes(kind);
}
