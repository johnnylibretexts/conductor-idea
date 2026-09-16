import { download, type ideaAPI } from '../../../api/idea';
import type { IdeaSavedRecord } from '../../../types/idea';
export function ExportMenu({ api, save, disabled, report }: { api: ReturnType<typeof ideaAPI>; save: () => Promise<IdeaSavedRecord>; disabled: boolean; report: (e: unknown) => void }) {
  return <>{(['json', 'md'] as const).map((format) => <button key={format} disabled={disabled} onClick={async () => { try { const saved = await save(); download(await api.export(saved.head._id, saved.revision._id, format, saved.head.kind), `idea-${saved.head.kind}-v${saved.head.version}.${format}`); } catch (e) { report(e); } }}>Export saved {format.toUpperCase()}</button>)}</>;
}
