"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { AlertCircle, Camera, ChevronDown, Image, Info, Plus, RefreshCw, Sparkles, Trash2, Upload } from "lucide-react";
import type { ImageGenerationSettings as ImageGenerationSettingsType, NovelAiPreset, OpenAiImagePreset } from "@/lib/settings-types";
import {
    DEFAULT_IMAGE_GENERATION_SETTINGS,
    DEFAULT_NOVELAI_PRESET,
    loadImageGenerationSettings,
    saveImageGenerationSettings,
} from "@/lib/settings-storage";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import { getChatImageFromIndexedDB, saveChatImageToIndexedDB } from "@/lib/chat-asset-storage";
import {
    fetchImageGenerationModels,
    fetchNovelAiModels,
    filterLikelyImageModels,
    generateImageFromConfiguredApi,
} from "@/lib/image-generation-service";
import { Alert } from "@/components/ui/feedback";
import { Input, Select, Textarea, Toggle } from "@/components/ui/form";
import { ConfirmDialog } from "@/components/ui/modal";
import {
    NOVELAI_COMMON_MODELS,
    NOVELAI_NOISE_SCHEDULE_OPTIONS,
    NOVELAI_RESOLUTION_OPTIONS,
    NOVELAI_SAMPLER_OPTIONS,
} from "@/lib/novelai-image-config";

const SIZE_OPTIONS = ["auto", "1024x1024", "1024x1536", "1536x1024"];
const QUALITY_OPTIONS = ["auto", "low", "medium", "high"];
const RATIO_HINT_MARKER = "【画面比例】";
const SIZE_RATIO_HINTS: Record<string, string> = {
    "1024x1024": "正方形 1:1 构图，square 1:1 composition",
    "1024x1536": "竖向 2:3 构图，vertical portrait composition",
    "1536x1024": "横向 3:2 构图，horizontal landscape composition",
};

function stripRatioHint(text: string): string {
    return text.replace(new RegExp(`\\s*${RATIO_HINT_MARKER}[^\\n]*`, "g"), "").replace(/\\s+$/, "");
}

function withRatioHint(extraPrompt: string, size: string): string {
    const base = stripRatioHint(extraPrompt);
    const hint = SIZE_RATIO_HINTS[size];
    if (!hint) return base;
    return base ? `${base}\n${RATIO_HINT_MARKER}${hint}` : `${RATIO_HINT_MARKER}${hint}`;
}

const IMAGE_HOSTING_PROVIDER_OPTIONS = [
    { value: "none", label: "不使用图床" },
    { value: "imgbb", label: "ImgBB" },
] as const;

const imageGenerationIconStyle = { "--icon-color": "#0EA5E9" } as CSSProperties;

type Status = { success: boolean; message: string };

export function ImageGenerationSettings() {
    const [settings, setSettings] = useState<ImageGenerationSettingsType>(DEFAULT_IMAGE_GENERATION_SETTINGS);
    const [characters, setCharacters] = useState<Character[]>([]);
    const [referencePreviews, setReferencePreviews] = useState<Record<string, string>>({});
    const [userReferencePreview, setUserReferencePreview] = useState<string | null>(null);
    const [models, setModels] = useState<string[]>([]);
    const [isFetchingModels, setIsFetchingModels] = useState(false);
    const [naiModels, setNaiModels] = useState<string[]>(NOVELAI_COMMON_MODELS);
    const [isFetchingNaiModels, setIsFetchingNaiModels] = useState(false);
    const [isTesting, setIsTesting] = useState(false);
    const [status, setStatus] = useState<Status | null>(null);
    const [naiTokenStatus, setNaiTokenStatus] = useState<Status | null>(null);
    const [testPreviewUrl, setTestPreviewUrl] = useState<string | null>(null);
    const [pendingDeletePresetId, setPendingDeletePresetId] = useState<string | null>(null);
    const [pendingDeleteOpenAiPresetId, setPendingDeleteOpenAiPresetId] = useState<string | null>(null);

    const openaiPresets = useMemo<OpenAiImagePreset[]>(() => (
        settings.openaiPresets?.length ? settings.openaiPresets : [{
            id: "preset_openai_default",
            name: "默认方案",
            requestMode: settings.requestMode,
            apiKey: settings.apiKey,
            baseUrl: settings.baseUrl,
            model: settings.model,
            size: settings.size,
            quality: settings.quality,
            extraPrompt: settings.extraPrompt,
        }]
    ), [settings]);

    const activeOpenAiPresetId = settings.activeOpenAiPresetId && openaiPresets.some(p => p.id === settings.activeOpenAiPresetId)
        ? settings.activeOpenAiPresetId
        : openaiPresets[0].id;
    const activeOpenAiPreset = openaiPresets.find(p => p.id === activeOpenAiPresetId) || openaiPresets[0];

    useEffect(() => {
        const loaded = loadImageGenerationSettings();
        setSettings(loaded);
        setCharacters(loadCharacters());
    }, []);

    useEffect(() => {
        if (settings.userReference?.assetId) {
            getChatImageFromIndexedDB(settings.userReference.assetId).then(setUserReferencePreview);
        } else {
            setUserReferencePreview(null);
        }
    }, [settings.userReference]);

    useEffect(() => {
        let cancelled = false;
        const refs = settings.characterReferences || {};
        Promise.all(Object.entries(refs).map(async ([characterId, ref]) => {
            const dataUrl = ref.assetId ? await getChatImageFromIndexedDB(ref.assetId) : null;
            return [characterId, dataUrl] as const;
        })).then(entries => {
            if (cancelled) return;
            const next: Record<string, string> = {};
            for (const [characterId, dataUrl] of entries) {
                if (dataUrl) next[characterId] = dataUrl;
            }
            setReferencePreviews(next);
        });
        return () => { cancelled = true; };
    }, [settings.characterReferences]);

    const persist = useCallback((next: ImageGenerationSettingsType) => {
        setSettings(next);
        saveImageGenerationSettings(next);
    }, []);

    const updateSettings = useCallback((patch: Partial<ImageGenerationSettingsType>) => {
        persist({ ...settings, ...patch });
    }, [persist, settings]);

    const uploadUserReference = async (file: File) => {
        const assetId = await saveChatImageToIndexedDB(file);
        persist({ ...settings, userReference: { assetId, updatedAt: Date.now() } });
    };

    const removeUserReference = () => {
        persist({ ...settings, userReference: undefined });
        setUserReferencePreview(null);
    };

    const uploadReference = async (characterId: string, file: File) => {
        const assetId = await saveChatImageToIndexedDB(file);
        persist({
            ...settings,
            characterReferences: { ...(settings.characterReferences || {}), [characterId]: { assetId, updatedAt: Date.now() } },
        });
    };

    const removeReference = (characterId: string) => {
        const nextRefs = { ...(settings.characterReferences || {}) };
        delete nextRefs[characterId];
        persist({ ...settings, characterReferences: nextRefs });
    };

    const updateOpenAiPreset = useCallback((patch: Partial<OpenAiImagePreset>) => {
        const nextPresets = openaiPresets.map(preset => preset.id === activeOpenAiPresetId ? { ...preset, ...patch } : preset);
        const active = nextPresets.find(preset => preset.id === activeOpenAiPresetId) || nextPresets[0];
        persist({ ...settings, openaiPresets: nextPresets, activeOpenAiPresetId, requestMode: active.requestMode, apiKey: active.apiKey, baseUrl: active.baseUrl, model: active.model, size: active.size, quality: active.quality, extraPrompt: active.extraPrompt });
    }, [activeOpenAiPresetId, openaiPresets, persist, settings]);

    const selectOpenAiPreset = useCallback((id: string) => {
        const active = openaiPresets.find(preset => preset.id === id);
        if (!active) return;
        persist({ ...settings, activeOpenAiPresetId: id, requestMode: active.requestMode, apiKey: active.apiKey, baseUrl: active.baseUrl, model: active.model, size: active.size, quality: active.quality, extraPrompt: active.extraPrompt });
    }, [openaiPresets, persist, settings]);

    const naiSettings = useMemo(() => {
        const nai = settings.novelai;
        const presets = nai?.presets && nai.presets.length > 0 ? nai.presets : [DEFAULT_NOVELAI_PRESET];
        const activePreset = presets.find(p => p.id === nai?.activePresetId) || presets[0];
        return { apiKey: nai?.apiKey || "", activePresetId: activePreset.id, presets, activePreset };
    }, [settings.novelai]);

    const updateNovelAi = useCallback((patch: Partial<import("@/lib/settings-types").NovelAiSettings>) => {
        persist({ ...settings, novelai: { ...naiSettings, ...patch } });
    }, [naiSettings, persist, settings]);

    const updateActivePreset = useCallback((patch: Partial<NovelAiPreset>) => {
        const nextPresets = naiSettings.presets.map(p => p.id === naiSettings.activePresetId ? { ...p, ...patch } : p);
        updateNovelAi({ presets: nextPresets });
    }, [naiSettings, updateNovelAi]);

    const fetchModels = async () => {
        setStatus(null);
        if (!activeOpenAiPreset.apiKey.trim() || !activeOpenAiPreset.baseUrl.trim()) {
            setStatus({ success: false, message: "请先填写 Base URL 和 API Key。" });
            return;
        }
        setIsFetchingModels(true);
        try {
            const fetched = await fetchImageGenerationModels(activeOpenAiPreset);
            setModels(fetched);
            setStatus({ success: true, message: fetched.length > 0 ? `已拉取 ${fetched.length} 个模型。` : "接口返回为空，可手动填写模型名。" });
        } catch (err) {
            setStatus({ success: false, message: err instanceof Error ? err.message : String(err) });
        } finally {
            setIsFetchingModels(false);
        }
    };

    const testGeneration = async () => {
        setStatus(null);
        setIsTesting(true);
        try {
            const result = await generateImageFromConfiguredApi({ description: "1girl, solo, masterpiece", settings: { ...settings, enabled: true } });
            if (!result) throw new Error("图像生成未返回结果。");
            if (testPreviewUrl) URL.revokeObjectURL(testPreviewUrl);
            setTestPreviewUrl(URL.createObjectURL(result.blob));
            setStatus({ success: true, message: "测试生图成功。" });
        } catch (err) {
            setStatus({ success: false, message: err instanceof Error ? err.message : String(err) });
        } finally {
            setIsTesting(false);
        }
    };

    return (
        <div className="flex flex-col gap-6 pb-8">
            <div className="flex items-center">
                <h2 className="m-0 mx-2 ts-28 font-bold italic leading-none text-black">Image Generation</h2>
            </div>

            <div className="menu-group">
                <div className="menu-item">
                    <span className="card-icon" style={imageGenerationIconStyle}><Sparkles size={22} strokeWidth={1.75} /></span>
                    <span className="settings-tools-menu-copy">
                        <span className="menu-label appearance-menu-item-label">启用自动生图</span>
                        <span className="menu-desc settings-tools-menu-desc">角色输出照片标签时自动调用图像生成 API。</span>
                    </span>
                    <span className="menu-right settings-tools-menu-toggle">
                        <Toggle checked={settings.enabled} onChange={(enabled) => updateSettings({ enabled })} className="settings-toggle-control" />
                    </span>
                </div>
            </div>

            <div className="menu-group p-4 flex flex-col gap-4">
                <div className="flex flex-col gap-1">
                    <label className="menu-desc ml-1">生图提供方 / 引擎</label>
                    <Select value={settings.provider || "openai"} onChange={(event) => updateSettings({ provider: event.target.value as "openai" | "novelai" })}>
                        <option value="openai">OpenAI 兼容 (通用模型 / DALL-E / Flux / SD 中转等)</option>
                        <option value="novelai">NovelAI 原生接口 (官方 API)</option>
                    </Select>
                </div>

                {settings.provider === "novelai" ? (
                    <div className="flex flex-col gap-4">
                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">NovelAI API Token</label>
                            <Input type="password" value={naiSettings.apiKey} onChange={(event) => updateNovelAi({ apiKey: event.target.value })} placeholder="pst-..." />
                        </div>
                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">模型 (Model)</label>
                            <Input type="text" value={naiSettings.activePreset.model} onChange={(event) => updateActivePreset({ model: event.target.value })} placeholder="nai-diffusion-4-curated-preview" />
                        </div>
                    </div>
                ) : (
                    <div className="flex flex-col gap-4">
                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">Base URL</label>
                            <Input type="url" value={activeOpenAiPreset.baseUrl} onChange={(event) => updateOpenAiPreset({ baseUrl: event.target.value })} placeholder="https://api.example.com/v1" />
                        </div>
                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">API Key</label>
                            <Input type="password" value={activeOpenAiPreset.apiKey} onChange={(event) => updateOpenAiPreset({ apiKey: event.target.value })} placeholder="sk-..." />
                        </div>
                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">模型名</label>
                            <div className="flex gap-2">
                                <Input className="flex-1" type="text" value={activeOpenAiPreset.model} onChange={(event) => updateOpenAiPreset({ model: event.target.value })} placeholder="gpt-image-2" />
                                <button type="button" onClick={fetchModels} disabled={isFetchingModels} className="ui-btn ui-btn-soft-action shrink-0">
                                    <RefreshCw size={16} className={isFetchingModels ? "animate-spin" : ""} /> 拉取模型
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                <button type="button" onClick={testGeneration} disabled={isTesting} className="ui-btn ui-btn-success flex-1"><Image size={16} /> {isTesting ? "测试中..." : "测试生图"}</button>
                {status && <Alert variant={status.success ? "success" : "danger"}>{status.message}</Alert>}
                {testPreviewUrl && <img src={testPreviewUrl} alt="测试结果" className="max-h-[220px] max-w-full rounded-xl object-contain" />}
            </div>

            <div className="flex flex-col gap-2">
                <p className="settings-menu-section-title">My Image Reference (User)</p>
                <div className="menu-group">
                    <div className="menu-item">
                        <span className="h-11 w-11 shrink-0 overflow-hidden rounded-xl bg-[var(--c-input)]">
                            {userReferencePreview ? <img src={userReferencePreview} alt="Me" className="h-full w-full object-cover" /> : <span className="flex h-full w-full items-center justify-center ts-13 font-semibold text-[var(--c-icon)]">Me</span>}
                        </span>
                        <span className="min-w-0 flex flex-1 flex-col">
                            <span className="menu-label truncate">我的形象锁定</span>
                            <span className="menu-desc truncate">{userReferencePreview ? "已从底层物理锁定" : "未设置（画你时长相随机）"}</span>
                        </span>
                        <span className="menu-right flex gap-2">
                            <button type="button" className="ui-link-btn" onClick={() => { const i = document.createElement("input"); i.type = "file"; i.accept = "image/*"; i.onchange = () => { const f = i.files?.[0]; if (f) uploadUserReference(f); }; i.click(); }}><Upload size={18} /></button>
                            {userReferencePreview && <button type="button" className="ui-link-btn" data-variant="danger" onClick={removeUserReference}><Trash2 size={18} /></button>}
                        </span>
                    </div>
                </div>
            </div>

            <div className="flex flex-col gap-2">
                <p className="settings-menu-section-title">Character References</p>
                <div className="menu-group">
                    {characters.map(character => (
                        <div key={character.id} className="menu-item">
                            <span className="h-11 w-11 shrink-0 overflow-hidden rounded-xl bg-[var(--c-input)]">
                                {referencePreviews[character.id] ? <img src={referencePreviews[character.id]} alt="" className="h-full w-full object-cover" /> : <span className="flex h-full w-full items-center justify-center ts-13 font-semibold text-[var(--c-icon)]">{character.name.slice(0, 1)}</span>}
                            </span>
                            <span className="min-w-0 flex flex-1 flex-col">
                                <span className="menu-label truncate">{character.name}</span>
                                <span className="menu-desc truncate">{referencePreviews[character.id] ? "已物理锁定参考图" : "未上传"}</span>
                            </span>
                            <span className="menu-right flex gap-2">
                                <button type="button" className="ui-link-btn" onClick={() => { const i = document.createElement("input"); i.type = "file"; i.accept = "image/*"; i.onchange = () => { const f = i.files?.[0]; if (f) uploadReference(character.id, f); }; i.click(); }}><Upload size={18} /></button>
                                {referencePreviews[character.id] && <button type="button" className="ui-link-btn" data-variant="danger" onClick={() => removeReference(character.id)}><Trash2 size={18} /></button>}
                            </span>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}
