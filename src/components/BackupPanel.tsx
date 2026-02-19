import { useRef, useState } from 'react';
import type { BossTable } from '../types';
import {
  applyMergeChoices,
  buildMergePreview,
  exportState,
  importState,
  type ConflictChoice,
  type MergePreview,
} from '../utils/backup';
import { formatTimestampLocal } from '../utils/time';

type BackupPanelProps = {
  tables: BossTable[];
  onReplaceTables: (tables: BossTable[]) => void;
};

async function copyText(text: string, textarea: HTMLTextAreaElement | null): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  if (!textarea) {
    throw new Error('Copy unavailable');
  }

  textarea.focus();
  textarea.select();
  const ok = document.execCommand('copy');
  if (!ok) {
    throw new Error('Copy unavailable');
  }
}

function formatChannelTimer(timer: { killedAt?: number; earliestRespawnAt?: number; latestRespawnAt?: number }): string {
  if (!timer.earliestRespawnAt && !timer.latestRespawnAt) return 'No timer';
  const earliest = formatTimestampLocal(timer.earliestRespawnAt);
  const latest = formatTimestampLocal(timer.latestRespawnAt);
  const killed = formatTimestampLocal(timer.killedAt);
  return `Killed: ${killed} | Earliest: ${earliest} | Latest: ${latest}`;
}

export function BackupPanel({ tables, onReplaceTables }: BackupPanelProps) {
  const [exportText, setExportText] = useState('');
  const [importText, setImportText] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [isBusy, setIsBusy] = useState(false);

  const [mergePreview, setMergePreview] = useState<MergePreview | null>(null);
  const [choices, setChoices] = useState<Record<string, ConflictChoice>>({});

  const exportRef = useRef<HTMLTextAreaElement>(null);

  const handleCopyBackup = async () => {
    setError('');
    setMessage('');
    setIsBusy(true);

    try {
      const backupString = await exportState(tables);
      setExportText(backupString);
      await copyText(backupString, exportRef.current);
      setMessage('Copied!');
    } catch {
      setMessage('Backup generated. Copy manually from the textarea.');
    } finally {
      setIsBusy(false);
    }
  };

  const handleMergeImport = async () => {
    setMessage('');
    setError('');
    setMergePreview(null);
    setIsBusy(true);

    try {
      const result = await importState(importText);
      const preview = buildMergePreview(tables, result.payload.tables);

      if (preview.conflicts.length === 0) {
        onReplaceTables(preview.mergedTables);
        setMessage(
          result.warnings.length > 0
            ? `Merged with warnings: ${result.warnings.join(' ')}`
            : `Merged ${result.payload.tables.length} table(s) with no conflicts.`
        );
      } else {
        setMergePreview(preview);
        setChoices(preview.defaultChoices);
        setMessage(
          `Found ${preview.conflicts.length} conflict(s). Choose what to keep, then click Apply Merge.`
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid backup string');
    } finally {
      setIsBusy(false);
    }
  };

  const handleChoiceChange = (conflictId: string, choice: ConflictChoice) => {
    setChoices((prev) => ({ ...prev, [conflictId]: choice }));
  };

  const handleApplyMerge = () => {
    if (!mergePreview) return;
    const finalTables = applyMergeChoices(mergePreview, choices);
    onReplaceTables(finalTables);
    setMergePreview(null);
    setMessage('Merge applied.');
  };

  return (
    <section className="panel">
      <h2>Backup</h2>
      <div className="backup-grid">
        <div>
          <button onClick={handleCopyBackup} disabled={isBusy}>
            Copy Backup
          </button>
          <label className="backup-label">
            Export String
            <textarea
              ref={exportRef}
              className="backup-textarea"
              value={exportText}
              readOnly
              placeholder={'Click "Copy Backup" to generate export string'}
            />
          </label>
        </div>

        <div>
          <label className="backup-label">
            Paste Backup Here
            <textarea
              className="backup-textarea"
              value={importText}
              onChange={(event) => setImportText(event.target.value)}
              placeholder="Paste BOSSTIMER_V2GZ:..., BOSSTIMER_V1:..., or raw JSON"
            />
          </label>
          <div className="backup-actions">
            <button onClick={handleMergeImport} disabled={isBusy}>
              Merge Import
            </button>
          </div>
        </div>
      </div>

      {mergePreview && (
        <div className="merge-conflicts">
          <h3>Merge Conflicts</h3>
          {mergePreview.conflicts.map((conflict) => (
            <div key={conflict.id} className="merge-conflict-card">
              <p className="merge-conflict-title">
                {conflict.bossName} - CH {conflict.channel}
              </p>
              <p className="muted">Mine: {formatChannelTimer(conflict.mine)}</p>
              <p className="muted">Theirs: {formatChannelTimer(conflict.theirs)}</p>
              <div className="merge-choice-row">
                <label>
                  <input
                    type="radio"
                    name={conflict.id}
                    checked={(choices[conflict.id] ?? 'mine') === 'mine'}
                    onChange={() => handleChoiceChange(conflict.id, 'mine')}
                  />
                  Keep mine
                </label>
                <label>
                  <input
                    type="radio"
                    name={conflict.id}
                    checked={(choices[conflict.id] ?? 'mine') === 'theirs'}
                    onChange={() => handleChoiceChange(conflict.id, 'theirs')}
                  />
                  Keep theirs
                </label>
              </div>
            </div>
          ))}

          <div className="backup-actions">
            <button onClick={handleApplyMerge}>Apply Merge</button>
            <button
              className="btn-ghost"
              onClick={() => {
                setMergePreview(null);
                setMessage('Merge canceled.');
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {message && <p className="backup-message">{message}</p>}
      {error && <p className="backup-error">{error}</p>}
    </section>
  );
}
