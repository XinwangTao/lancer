import { useId, useMemo, useRef, useState } from "react";
import { ModelBrandIcon } from "../../ui/model-brand-icon";
import { MODEL_FAMILIES, modelFamily } from "../../ui/model-families";
import { LOCAL_APP_ENTRIES } from "../../ui/local-app-entries";
import type { LocalAppId } from "../../../contracts/ipc";
import type { RuntimeSnapshot, RuntimeModelRecord } from "@lancer/session-driver/runtime-types";
import { buildModelOptions } from "./composer-commands";
import "./model-catalog.css";

export function ModelReel({
  onSelectDoubaoApp,
  doubaoActive,
  runtime,
  provider,
  modelId,
  disabled,
  onSelectModel,
}: {
  readonly onSelectDoubaoApp?: () => void;
  readonly doubaoActive?: boolean;
  readonly runtime?: RuntimeSnapshot;
  readonly provider?: string;
  readonly modelId?: string;
  readonly disabled?: boolean;
  readonly onSelectModel: (provider: string, modelId: string) => void;
}) {
  const id = useId();
  const popover = useRef<HTMLDivElement>(null);
  const [familyId, setFamilyId] = useState<string>(modelFamily(provider, modelId)?.id ?? "openai");
  const [appId, setAppId] = useState<LocalAppId | null>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const available = useMemo(
    () => new Set(buildModelOptions(runtime).map((m) => `${m.providerId}/${m.modelId}`)),
    [runtime],
  );
  const families = MODEL_FAMILIES;
  const catalog = useMemo(() => {
    const groups = new Map<string, RuntimeModelRecord[]>();
    const counts = new Map<string, number>();
    for (const model of runtime?.models ?? []) {
      const family = modelFamily(model.providerId, model.modelId, model.label)?.id;
      if (!family) continue;
      const group = groups.get(family) ?? [];
      group.push(model);
      groups.set(family, group);
      if (available.has(`${model.providerId}/${model.modelId}`))
        counts.set(family, (counts.get(family) ?? 0) + 1);
    }
    return { groups, counts };
  }, [runtime?.models, available]);
  const models = catalog.groups.get(familyId) ?? [];
  const hasAppEntry = familyId === "doubao" && Boolean(onSelectDoubaoApp);
  const appEntry = LOCAL_APP_ENTRIES.find((entry) => entry.id === appId);
  const matches = (open ? models : [])
    .filter((m) =>
      `${m.label} ${m.providerId} ${m.modelId}`.toLowerCase().includes(query.toLowerCase()),
    )
    .sort(
      (a, b) =>
        Number(available.has(`${b.providerId}/${b.modelId}`)) -
        Number(available.has(`${a.providerId}/${a.modelId}`)),
    );
  const activeModel = runtime?.models.find(
    (model) => model.providerId === provider && model.modelId === modelId,
  );
  const activeFamily = doubaoActive
    ? "doubao"
    : modelFamily(provider, modelId, activeModel?.label)?.id;
  const placePopover = (target: HTMLElement) => {
    const bounds = target.getBoundingClientRect();
    popover.current?.style.setProperty(
      "--catalog-x",
      `${Math.max(8, Math.min(bounds.left, innerWidth - 340))}px`,
    );
  };
  const launchApp = (target: LocalAppId) => {
    setLaunchError(null);
    const api = window.piApp;
    if (!api?.launchLocalApp) {
      setLaunchError("当前客户端版本不支持启动本机 App。");
      return;
    }
    void api
      .launchLocalApp(target)
      .then(() => popover.current?.hidePopover())
      .catch((error: unknown) => {
        setLaunchError(error instanceof Error ? error.message : String(error));
      });
  };
  return (
    <div className="model-catalog" data-testid="model-reel">
      <div className="model-catalog__families" aria-label="模型与应用">
        {families.map((family) => {
          const count = catalog.counts.get(family.id) ?? 0;
          return (
            <button
              type="button"
              key={family.id}
              popoverTarget={id}
              popoverTargetAction="show"
              disabled={disabled}
              aria-pressed={!appEntry && activeFamily === family.id}
              data-anchor-key={`family:${family.id}`}
              title={
                family.id === "doubao" && onSelectDoubaoApp
                  ? `${family.label} · App 直连${count ? ` · ${count} 个可用 API 模型` : ""}`
                  : `${family.label} · ${count} 个可用模型`
              }
              className={
                count || (family.id === "doubao" && onSelectDoubaoApp) ? "" : "unconfigured"
              }
              onClick={(e) => {
                setAppId(null);
                setFamilyId(family.id);
                setQuery("");
                placePopover(e.currentTarget);
              }}
            >
              <ModelBrandIcon provider={family.id} />
              <span>{family.label}</span>
            </button>
          );
        })}
        <span className="model-catalog__divider" aria-hidden="true" />
        {LOCAL_APP_ENTRIES.map((entry) => (
          <button
            type="button"
            key={entry.id}
            popoverTarget={id}
            popoverTargetAction="show"
            disabled={disabled}
            aria-pressed={appEntry?.id === entry.id}
            data-anchor-key={`app:${entry.id}`}
            title={`${entry.label} · ${entry.hint}`}
            onClick={(e) => {
              setAppId(entry.id);
              setQuery("");
              setLaunchError(null);
              placePopover(e.currentTarget);
            }}
          >
            <ModelBrandIcon mark={entry.id} />
            <span>{entry.label}</span>
          </button>
        ))}
      </div>
      <span
        className="model-catalog__current"
        title={doubaoActive ? "豆包 App" : `${provider} · ${modelId}`}
      >
        {doubaoActive ? "豆包 App" : (modelId ?? "选择模型")}
      </span>
      <div
        ref={popover}
        id={id}
        popover="auto"
        className="model-catalog__popover"
        aria-label={appEntry ? `${appEntry.label} 操作` : "模型选择"}
        onToggle={(event) => {
          const isOpen = event.currentTarget.matches(":popover-open");
          setOpen(isOpen);
          // Dismissing the panel restores the current model family highlight.
          if (!isOpen) setAppId(null);
        }}
      >
        {appEntry ? (
          <>
            <header>
              {appEntry.label}
              <span>本机 App</span>
            </header>
            <button
              type="button"
              aria-label={`打开 ${appEntry.label}`}
              data-testid={`catalog-local-app-${appEntry.id}`}
              disabled={disabled}
              onClick={() => launchApp(appEntry.id)}
            >
              <ModelBrandIcon mark={appEntry.id} />
              <span>
                打开 {appEntry.label}
                <small>{appEntry.hint}</small>
              </span>
            </button>
            {launchError ? (
              <p className="model-catalog__error" role="alert">
                {launchError}
              </p>
            ) : null}
          </>
        ) : (
          <>
            <header>
              {families.find((f) => f.id === familyId)?.label}
              <span>
                {hasAppEntry
                  ? `App 直连${models.length ? ` · ${models.length} 个 API 模型` : ""}`
                  : `${models.length} 个模型`}
              </span>
            </header>
            {models.length > 6 ? (
              <input
                type="search"
                aria-label="搜索模型"
                placeholder="搜索模型"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            ) : null}
            {hasAppEntry ? (
              <button
                type="button"
                aria-label="打开豆包 App"
                aria-pressed={Boolean(doubaoActive)}
                disabled={disabled}
                data-testid="catalog-doubao-app"
                onClick={() => {
                  popover.current?.hidePopover();
                  onSelectDoubaoApp?.();
                }}
              >
                <ModelBrandIcon provider="doubao" />
                <span>
                  打开豆包 App<small>GUI 对话直连{doubaoActive ? " · 当前会话" : ""}</small>
                </span>
              </button>
            ) : null}
            {matches.map((model) => {
              const enabled = available.has(`${model.providerId}/${model.modelId}`);
              return (
                <button
                  type="button"
                  key={`${model.providerId}/${model.modelId}`}
                  disabled={!enabled || disabled}
                  aria-pressed={provider === model.providerId && modelId === model.modelId}
                  onClick={() => {
                    popover.current?.hidePopover();
                    onSelectModel(model.providerId, model.modelId);
                  }}
                >
                  <ModelBrandIcon provider={model.providerId} modelId={model.modelId} />
                  <span>
                    {model.label}
                    <small>
                      {model.providerId} · {model.modelId}
                    </small>
                  </span>
                  {!enabled ? <small>{model.available ? "未启用" : "未配置"}</small> : null}
                </button>
              );
            })}
            {!models.length && !hasAppEntry ? (
              <p>尚未配置此模型家族，可在工作区设置中连接。</p>
            ) : null}
            {models.length > 0 && !matches.length ? <p>没有匹配的模型。</p> : null}
          </>
        )}
      </div>
    </div>
  );
}
