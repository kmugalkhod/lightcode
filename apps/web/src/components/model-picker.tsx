import { useEffect, useRef, useState } from "react";
import type { LightcodeApi, ModelList, ProviderStatus } from "../lib/api";
import { Icon } from "./icons";

export function ModelPicker({ api, status, onClose, onSelect }: {
  api: LightcodeApi;
  status: ProviderStatus;
  onClose: () => void;
  onSelect: (status: ProviderStatus) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [models, setModels] = useState<ModelList["models"]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selectionLock = useRef(false);

  useEffect(() => {
    dialog.current?.showModal();
    let active = true;
    void api.listModels(status.selectedProvider).then((result) => {
      if (active) setModels(result.models);
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : "Models could not be loaded. Enter an exact model ID below.");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, status.selectedProvider]);

  async function select(model: string) {
    if (selectionLock.current) return;
    selectionLock.current = true;
    setSaving(model);
    setError(null);
    try {
      const result = await api.selectModel(status.selectedProvider, model);
      onSelect(result);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Model could not be changed. Try again.");
    } finally { selectionLock.current = false; setSaving(null); }
  }

  const filtered = models.filter((model) => `${model.name} ${model.id}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <dialog ref={dialog} className="model-picker" aria-labelledby="model-picker-title" onCancel={(event) => { event.preventDefault(); if (!saving) onClose(); }} onClick={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}>
    <div className="model-picker-content">
      <header><div><h2 id="model-picker-title">Choose a model</h2><p>{status.selectedProvider} · Used for subsequent requests</p></div><button className="icon-button" type="button" aria-label="Close model picker" onClick={onClose} disabled={Boolean(saving)}><Icon name="x" /></button></header>
      <label className="model-search"><Icon name="search" /><input autoFocus value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="Search models or enter an exact ID…" aria-label="Search models" disabled={Boolean(saving)} /></label>
      {error ? <p className="model-picker-error" role="alert">{error}</p> : null}
      <div className="model-list" aria-busy={loading || Boolean(saving)}>
        {loading ? <div className="session-skeleton" aria-label="Loading models"><span /><span /><span /></div> : filtered.slice(0, 100).map((model) => <button key={model.id} className={model.id === status.selectedModel ? "model-option selected" : "model-option"} type="button" disabled={Boolean(saving)} onClick={() => void select(model.id)}>
          <span><strong>{model.name}</strong><small>{model.id}</small></span><span className="model-capability">{saving === model.id ? "Switching…" : model.id === status.selectedModel ? "Selected" : model.contextLength ? `${Math.round(model.contextLength / 1000)}k context` : ""}</span>
        </button>)}
        {!loading && !filtered.length ? <p className="model-list-empty">No matching models. You can use an exact model ID.</p> : null}
      </div>
      <footer><span>{loading ? "Loading catalog…" : `${filtered.length} models${filtered.length > 100 ? " · Refine your search to see more" : ""}`}</span>{query.trim() && !models.some((model) => model.id === query.trim()) ? <button className="secondary-button" disabled={Boolean(saving)} onClick={() => void select(query.trim())}>Use this model ID</button> : null}</footer>
    </div>
  </dialog>;
}
