import { useEffect, useState } from 'react';
import {
  CircleHelp,
  Cpu,
  FileCode2,
  GitBranch,
  GitCompareArrows,
  HardDrive,
  Plus,
  RefreshCw,
  Save,
  Search,
  TerminalSquare,
} from 'lucide-react';
import type { ProjectProfile } from '../../shared/types';
import { api } from '../api';
import { PageHeading, EmptyState, Meta } from './shared/parts';
import { commandText, parseCommand } from './shared/format';

export function ProjectsPage({
  projects,
  onChanged,
  onNotice,
}: {
  projects: ProjectProfile[];
  onChanged: () => void;
  onNotice: (message: string) => void;
}) {
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [selectedId, setSelectedId] = useState(projects[0]?.id ?? '');
  const selected = projects.find((project) => project.id === selectedId);
  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await api.addProject(path);
      setPath('');
      setSelectedId(result.project.id);
      onChanged();
      onNotice(`${result.project.name} added to this machine.`);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Project could not be added.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="page-content">
      <PageHeading
        title="Projects"
        description="Repositories registered on this machine, with detected profile and test commands."
      />
      <div className={`projects-layout ${projects.length === 0 ? 'projects-layout-empty' : ''}`}>
        <section className="surface-panel projects-list-panel">
          <div className="panel-title-row">
            <div>
              <h2>Registered projects</h2>
              <p>{projects.length} on this machine</p>
            </div>
            <FileCode2 size={17} className="muted-icon" />
          </div>
          <form className="add-project-form" onSubmit={add}>
            <label className="form-field">
              <span>Local folder path</span>
              <input
                value={path}
                onChange={(event) => setPath(event.target.value)}
                placeholder="/home/alex/code/my-project"
                required
              />
            </label>
            <button className="primary-button" disabled={busy || !path.trim()}>
              <Plus size={15} />
              {busy ? 'Inspecting…' : 'Add project'}
            </button>
            <small>
              Run this interface on the desktop master to register a local folder. A mobile browser cannot
              browse desktop files.
            </small>
          </form>
          <div className="project-select-list">
            {projects.map((project) => (
              <button
                className={`project-row ${project.id === selectedId ? 'project-selected' : ''}`}
                key={project.id}
                onClick={() => setSelectedId(project.id)}
              >
                <span className="project-row-symbol">
                  <HardDrive size={17} />
                </span>
                <span>
                  <strong>{project.name}</strong>
                  <small>{project.path}</small>
                </span>
                <span className={`status-pill ${project.dirty ? 'status-attention' : 'status-ready'}`}>
                  {project.dirty === null ? 'No Git' : project.dirty ? 'Dirty' : 'Clean'}
                </span>
              </button>
            ))}
            {projects.length === 0 && (
              <EmptyState
                icon={FileCode2}
                title="No projects yet"
                body="Add a local folder path above. The master will detect Git, languages, package scripts, and project instructions."
              />
            )}
          </div>
        </section>
        {projects.length > 0 && (
          <section className="project-profile-column">
            {selected ? (
              <ProjectProfilePanel
                project={selected}
                onSaved={() => {
                  onChanged();
                  onNotice('Project profile updated.');
                }}
                onNotice={onNotice}
              />
            ) : (
              <EmptyState
                icon={Search}
                title="Select a project"
                body="Detected project details will appear here."
              />
            )}
          </section>
        )}
      </div>
    </main>
  );
}

function ProjectProfilePanel({
  project,
  onSaved,
  onNotice,
}: {
  project: ProjectProfile;
  onSaved: () => void;
  onNotice: (message: string) => void;
}) {
  const [name, setName] = useState(project.name);
  const [buildCommand, setBuildCommand] = useState(commandText(project.buildCommand));
  const [testCommand, setTestCommand] = useState(commandText(project.testCommand));
  const [lintCommand, setLintCommand] = useState(commandText(project.lintCommand));
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    setName(project.name);
    setBuildCommand(commandText(project.buildCommand));
    setTestCommand(commandText(project.testCommand));
    setLintCommand(commandText(project.lintCommand));
  }, [project]);
  const save = async () => {
    try {
      await api.patchProject(project.id, {
        name,
        buildCommand: parseCommand(buildCommand),
        testCommand: parseCommand(testCommand),
        lintCommand: parseCommand(lintCommand),
      });
      onSaved();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Project profile could not be saved.');
    }
  };
  const refreshProject = async () => {
    setRefreshing(true);
    try {
      await api.refreshProject(project.id);
      onSaved();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Project details could not be refreshed.');
    } finally {
      setRefreshing(false);
    }
  };
  return (
    <section className="surface-panel project-profile-panel">
      <div className="panel-title-row">
        <div>
          <h2>Project profile</h2>
          <p>Correct the detected values before running workflows.</p>
        </div>
        <button
          className="icon-button small-icon"
          title="Refresh project details"
          aria-label="Refresh project details"
          disabled={refreshing}
          onClick={() => void refreshProject()}
        >
          <RefreshCw size={15} />
        </button>
      </div>
      <div className="project-detail-banner">
        <span className="project-banner-symbol">
          <FileCode2 size={18} />
        </span>
        <div>
          <strong>{project.name}</strong>
          <code>{project.path}</code>
        </div>
        <span className={`status-pill ${project.gitRoot ? 'status-ready' : 'status-attention'}`}>
          {project.gitRoot ? 'Git repository' : 'Folder'}
        </span>
      </div>
      <dl className="metadata-grid">
        <Meta label="Current branch" value={project.branch ?? 'Not detected'} icon={GitBranch} />
        <Meta
          label="Working tree"
          value={
            project.dirty === null
              ? 'Git status unavailable'
              : project.dirty
                ? 'Uncommitted changes'
                : 'Clean'
          }
          icon={GitCompareArrows}
        />
        <Meta
          label="Package manager"
          value={project.packageManager ?? 'Not detected'}
          icon={TerminalSquare}
        />
        <Meta
          label="Primary languages"
          value={project.languages.join(', ') || 'Not detected'}
          icon={FileCode2}
        />
        <Meta label="Frameworks" value={project.frameworks.join(', ') || 'Not detected'} icon={Cpu} />
        <Meta
          label="Instructions"
          value={project.instructionFiles.length ? project.instructionFiles.join(', ') : 'None found'}
          icon={CircleHelp}
        />
      </dl>
      <div className="project-command-editor">
        <div>
          <h3>Project commands</h3>
          <p>Only these package-script commands run automatically.</p>
        </div>
        <label className="form-field">
          <span>Project name</span>
          <input value={name} maxLength={120} onChange={(event) => setName(event.target.value)} />
        </label>
        <CommandEditor label="Build command" value={buildCommand} onChange={setBuildCommand} />
        <CommandEditor label="Test command" value={testCommand} onChange={setTestCommand} />
        <CommandEditor label="Lint command" value={lintCommand} onChange={setLintCommand} />
        <button className="primary-button align-right" onClick={() => void save()}>
          <Save size={14} />
          Save profile
        </button>
      </div>
    </section>
  );
}

function CommandEditor({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="form-field">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">Not configured</option>
        {['npm', 'pnpm', 'yarn', 'bun'].map((tool) => (
          <option value={`${tool} run ${label.toLowerCase().split(' ')[0]}`} key={tool}>
            {tool} run {label.toLowerCase().split(' ')[0]}
          </option>
        ))}
      </select>
    </label>
  );
}
