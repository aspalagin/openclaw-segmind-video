import { setTimeout as delay } from "node:timers/promises";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import { coerceSecretRef, hasConfiguredSecretInput } from "openclaw/plugin-sdk/secret-input";
import { resolveSecretRefValues } from "openclaw/plugin-sdk/secret-ref-runtime";

const PROVIDER_ID = "segmind";
const DEFAULT_BASE_URL = "https://api.segmind.com";
const DEFAULT_TIMEOUT_MS = 900_000;
const POLL_INTERVAL_MS = 2_000;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const YANDEX_DISK_API_BASE_URL = "https://cloud-api.yandex.net/v1/disk";
const DEFAULT_YANDEX_DISK_REFS_DIR = "/segmind-refs";
const SEGMIND_REMAINING_CREDITS_HEADER = "x-remaining-credits";

const ASPECT_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "adaptive"];
const FULL_DURATIONS = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
const COMPACT_DURATIONS = [4, 5, 6, 8, 10, 12, 15];

const MODEL_CONFIGS = {
  "seedance-2.0": {
    endpoint: "seedance-2.0",
    label: "Seedance 2.0",
    resolutions: ["480P", "720P", "1080P", "4K"],
    durations: FULL_DURATIONS,
  },
  "seedance-2.0/reference-to-video": {
    endpoint: "seedance-2.0",
    label: "Seedance 2.0 Reference to Video",
    resolutions: ["480P", "720P", "1080P", "4K"],
    durations: FULL_DURATIONS,
    referenceToVideo: true,
  },
  "sedance-2.0": {
    endpoint: "seedance-2.0",
    label: "Seedance 2.0",
    resolutions: ["480P", "720P", "1080P", "4K"],
    durations: FULL_DURATIONS,
  },
  "seedance-2.0-fast": {
    endpoint: "seedance-2.0-fast",
    label: "Seedance 2.0 Fast",
    resolutions: ["480P", "720P"],
    durations: COMPACT_DURATIONS,
  },
  "seedance-2.0-fast/reference-to-video": {
    endpoint: "seedance-2.0-fast",
    label: "Seedance 2.0 Fast Reference to Video",
    resolutions: ["480P", "720P"],
    durations: COMPACT_DURATIONS,
    referenceToVideo: true,
  },
  "seedance-2.0-mini": {
    endpoint: "seedance-2.0-mini",
    label: "Seedance 2.0 Mini",
    resolutions: ["480P", "720P", "1080P"],
    durations: COMPACT_DURATIONS,
  },
  "seedance-2.0-mini/reference-to-video": {
    endpoint: "seedance-2.0-mini",
    label: "Seedance 2.0 Mini Reference to Video",
    resolutions: ["480P", "720P", "1080P"],
    durations: COMPACT_DURATIONS,
    referenceToVideo: true,
  },
};

const MODEL_IDS = Object.keys(MODEL_CONFIGS);
const DEFAULT_MODEL = "seedance-2.0";

function normalizeOptionalString(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/u, "");
}

function resolveBaseUrl(cfg) {
  return stripTrailingSlash(
    normalizeOptionalString(cfg?.plugins?.entries?.segmind?.config?.baseUrl)
    ?? normalizeOptionalString(cfg?.models?.providers?.segmind?.baseUrl)
    ?? DEFAULT_BASE_URL
  );
}

function resolveGeneratedVideoMaxBytes(req) {
  const configured = req.cfg?.agents?.defaults?.mediaMaxMb;
  if (typeof configured === "number" && Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured * 1024 * 1024);
  }
  return DEFAULT_MAX_BYTES;
}

function resolveModelConfig(model) {
  const normalized = normalizeOptionalString(model) ?? DEFAULT_MODEL;
  const config = MODEL_CONFIGS[normalized];
  if (!config) {
    throw new Error(`Модель Segmind не поддерживается: ${normalized}. Доступны: ${MODEL_IDS.join(", ")}.`);
  }
  return { id: normalized, ...config };
}

function buildCapabilities(config) {
  const base = {
    maxVideos: 1,
    maxDurationSeconds: 15,
    supportedDurationSeconds: config.durations,
    resolutions: config.resolutions,
    aspectRatios: ASPECT_RATIOS,
    supportsResolution: true,
    supportsAspectRatio: true,
    supportsAudio: true,
    providerOptions: {
      seed: "number",
      return_last_frame: "boolean",
      skip_moderation: "boolean",
      first_frame_url: "string",
      last_frame_url: "string",
      mode: "string",
    },
  };
  return {
    generate: base,
    imageToVideo: {
      ...base,
      enabled: true,
      maxInputImages: 9,
      maxInputAudios: 3,
    },
    videoToVideo: {
      ...base,
      enabled: true,
      maxInputVideos: 3,
      maxInputAudios: 3,
    },
  };
}

function normalizeResolution(value, config) {
  const requested = normalizeOptionalString(value);
  if (!requested) return "720p";
  const normalized = requested.toLowerCase();
  if (normalized === "4k") return "4k";
  if (/^\d+p$/u.test(normalized)) return normalized;
  const fallback = config.resolutions[0] ?? "720P";
  return fallback.toLowerCase();
}

function resolveDuration(value, config) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 5;
  const rounded = Math.round(value);
  if (config.durations.includes(rounded)) return rounded;
  return config.durations.reduce((best, candidate) => (
    Math.abs(candidate - rounded) < Math.abs(best - rounded) ? candidate : best
  ), config.durations[0] ?? 5);
}

function resolveAspectRatio(value) {
  const requested = normalizeOptionalString(value);
  if (!requested) return "16:9";
  return ASPECT_RATIOS.includes(requested) ? requested : "16:9";
}

function isReferenceToVideoMode(value) {
  const requested = normalizeOptionalString(value);
  if (!requested) return false;
  const normalized = requested.toLowerCase().replace(/_/gu, "-");
  return normalized === "reference-to-video" || normalized === "referencetovideo" || normalized === "r2v";
}

function resolveReferenceToVideoMode(config, options) {
  const requested = normalizeOptionalString(options.mode);
  if (!requested) return config.referenceToVideo === true;
  if (isReferenceToVideoMode(requested)) return true;
  const normalized = requested.toLowerCase().replace(/_/gu, "-");
  if (["image-to-video", "i2v", "text-to-video", "t2v", "first-frame"].includes(normalized)) return false;
  throw new Error(`Режим Segmind не поддерживается: ${requested}. Доступны: reference-to-video, image-to-video, text-to-video.`);
}

function isHttpUrl(value) {
  return /^https?:\/\//iu.test(value);
}

function requireYandexDiskToken() {
  const token = normalizeOptionalString(process.env.YANDEX_DISK_TOKEN);
  if (!token) {
    throw new Error("YANDEX_DISK_TOKEN не найден: не могу загрузить локальный референс на Яндекс.Диск.");
  }
  return token;
}

function resolveYandexDiskRefsDir() {
  const configured = normalizeOptionalString(process.env.YANDEX_DISK_REFS_DIR);
  return configured?.startsWith("/") ? configured : DEFAULT_YANDEX_DISK_REFS_DIR;
}

function buildYandexDiskUrl(pathname, params = {}) {
  const url = new URL(`${YANDEX_DISK_API_BASE_URL}${pathname}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url;
}

function yandexDiskHeaders(token) {
  return { Authorization: `OAuth ${token}` };
}

async function assertYandexOk(response, label, allowedStatuses = []) {
  if (response.ok || allowedStatuses.includes(response.status)) return;
  const body = await readTextSafe(response);
  throw new Error(`${label}: HTTP ${response.status}${body ? `: ${body}` : ""}`);
}

async function readYandexJson(response, label, allowedStatuses = []) {
  await assertYandexOk(response, label, allowedStatuses);
  try {
    return await response.json();
  } catch (error) {
    throw new Error(`${label}: ответ Яндекс.Диска не является JSON`, { cause: error });
  }
}

async function ensureYandexDiskRefsDir(token, refsDir) {
  const response = await fetch(buildYandexDiskUrl("/resources", { path: refsDir }), {
    method: "PUT",
    headers: yandexDiskHeaders(token),
  });
  await assertYandexOk(response, `Создание папки Яндекс.Диска ${refsDir} не удалось`, [409]);
}

function safeYandexDiskFileName(fileName) {
  const baseName = path.basename(normalizeOptionalString(fileName) ?? "reference.bin");
  const safeName = baseName.replace(/[<>:"|?*\u0000-\u001F]/gu, "_");
  return safeName || "reference.bin";
}

function yandexDiskTargetPath(fileName, buffer, refsDir) {
  const hash = createHash("sha256").update(buffer).digest("hex").slice(0, 12);
  const uniqueName = `${Date.now()}-${hash}-${randomUUID()}-${safeYandexDiskFileName(fileName)}`;
  return `${refsDir}/${uniqueName}`;
}

async function getYandexUploadHref(token, diskPath) {
  const response = await fetch(buildYandexDiskUrl("/resources/upload", {
    path: diskPath,
    overwrite: "true",
  }), {
    method: "GET",
    headers: yandexDiskHeaders(token),
  });
  const payload = await readYandexJson(response, "Получение upload href Яндекс.Диска не удалось");
  const href = normalizeOptionalString(payload?.href);
  if (!href) throw new Error("Яндекс.Диск не вернул upload href.");
  return href;
}

async function publishYandexDiskResource(token, diskPath) {
  const response = await fetch(buildYandexDiskUrl("/resources/publish", { path: diskPath }), {
    method: "PUT",
    headers: yandexDiskHeaders(token),
  });
  await assertYandexOk(response, "Публикация файла на Яндекс.Диске не удалась", [409]);
  if (response.status === 409) return undefined;
  try {
    const payload = await response.json();
    return normalizeOptionalString(payload?.href);
  } catch {
    return undefined;
  }
}

async function readYandexDiskPublicKey(token, diskPath, resourceHref) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const resourceUrl = normalizeOptionalString(resourceHref) ?? buildYandexDiskUrl("/resources", {
      path: diskPath,
      fields: "public_key,public_url",
    });
    const response = await fetch(resourceUrl, {
      method: "GET",
      headers: yandexDiskHeaders(token),
    });
    const payload = await readYandexJson(response, "Получение public_key Яндекс.Диска не удалось");
    const publicKey = normalizeOptionalString(payload?.public_key) ?? normalizeOptionalString(payload?.public_url);
    if (publicKey) return publicKey;
    await delay(1_000);
  }
  throw new Error("Яндекс.Диск не вернул public_key опубликованного файла.");
}

async function getYandexDiskDownloadHref(token, publicKey) {
  const response = await fetch(buildYandexDiskUrl("/public/resources/download", { public_key: publicKey }), {
    method: "GET",
    headers: yandexDiskHeaders(token),
  });
  const payload = await readYandexJson(response, "Получение прямой ссылки Яндекс.Диска не удалось");
  const href = normalizeOptionalString(payload?.href);
  if (!href || !isHttpUrl(href)) throw new Error("Яндекс.Диск не вернул прямой download href.");
  return href;
}

async function uploadBufferToYandexDisk({ buffer, fileName }) {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error("Локальный референс не содержит читаемый буфер.");
  }
  const token = requireYandexDiskToken();
  const refsDir = resolveYandexDiskRefsDir();
  await ensureYandexDiskRefsDir(token, refsDir);
  const diskPath = yandexDiskTargetPath(fileName, buffer, refsDir);
  const uploadHref = await getYandexUploadHref(token, diskPath);
  const uploadResponse = await fetch(uploadHref, {
    method: "PUT",
    body: buffer,
  });
  await assertYandexOk(uploadResponse, "Загрузка файла на Яндекс.Диск не удалась");
  const resourceHref = await publishYandexDiskResource(token, diskPath);
  const publicKey = await readYandexDiskPublicKey(token, diskPath, resourceHref);
  return await getYandexDiskDownloadHref(token, publicKey);
}

export async function uploadLocalFileToYandexDisk(filePath) {
  const localPath = normalizeOptionalString(filePath);
  if (!localPath) throw new Error("Путь к локальному референсу пустой.");
  let buffer;
  try {
    buffer = await readFile(localPath);
  } catch (error) {
    throw new Error(`Не удалось прочитать локальный референс ${localPath}: ${error.message}`, { cause: error });
  }
  return await uploadBufferToYandexDisk({ buffer, fileName: path.basename(localPath) });
}

function resolveLocalReferencePath(asset) {
  const candidates = [
    asset?.path,
    asset?.filePath,
    asset?.localPath,
    asset?.metadata?.path,
    asset?.metadata?.filePath,
    asset?.metadata?.localPath,
  ];
  for (const candidate of candidates) {
    const value = normalizeOptionalString(candidate);
    if (value) return value.startsWith("file://") ? fileURLToPath(value) : value;
  }
  const url = normalizeOptionalString(asset?.url);
  if (url && !isHttpUrl(url)) return url.startsWith("file://") ? fileURLToPath(url) : url;
  return undefined;
}

async function resolveReferenceUrl(asset, label) {
  const url = normalizeOptionalString(asset?.url);
  if (url && isHttpUrl(url)) return url;
  try {
    const localPath = resolveLocalReferencePath(asset);
    if (localPath) return await uploadLocalFileToYandexDisk(localPath);
    if (asset?.buffer) {
      return await uploadBufferToYandexDisk({
        buffer: asset.buffer,
        fileName: normalizeOptionalString(asset.fileName) ?? `${label}.bin`,
      });
    }
  } catch (error) {
    throw new Error(`Не удалось подготовить ${label} для Segmind: ${error.message}`, { cause: error });
  }
  throw new Error(`Segmind не получил ${label}: нужен http(s)-URL или локальный файл для загрузки на Яндекс.Диск.`);
}

async function resolveReferenceStringUrl(value, label) {
  const url = normalizeOptionalString(value);
  if (!url) return undefined;
  if (isHttpUrl(url)) return url;
  return await resolveReferenceUrl({ url }, label);
}

async function appendReferenceImages(payload, assets = [], { referenceToVideo = false } = {}) {
  let firstFrameUrl = normalizeOptionalString(payload.first_frame_url);
  let lastFrameUrl = normalizeOptionalString(payload.last_frame_url);
  const references = [];

  for (const [index, asset] of assets.entries()) {
    const url = await resolveReferenceUrl(asset, `изображение ${index + 1}`);
    const role = normalizeOptionalString(asset.role)?.toLowerCase();
    if (role === "first_frame") {
      firstFrameUrl = url;
    } else if (role === "last_frame") {
      lastFrameUrl = url;
    } else if (referenceToVideo || role) {
      references.push(url);
    } else if (assets.length === 1 && !firstFrameUrl) {
      firstFrameUrl = url;
    } else {
      references.push(url);
    }
  }

  if (firstFrameUrl && references.length > 0) {
    throw new Error("Segmind не принимает first_frame_url вместе с reference_images.");
  }
  if (lastFrameUrl && !firstFrameUrl) {
    throw new Error("Segmind требует first_frame_url, если указан last_frame_url.");
  }

  if (firstFrameUrl) payload.first_frame_url = firstFrameUrl;
  if (lastFrameUrl) payload.last_frame_url = lastFrameUrl;
  payload.reference_images = references;
}

async function appendReferenceVideos(payload, assets = []) {
  payload.reference_videos = await Promise.all(assets.map((asset, index) => resolveReferenceUrl(asset, `видео ${index + 1}`)));
}

async function appendReferenceAudios(payload, assets = []) {
  payload.reference_audios = await Promise.all(assets.map((asset, index) => resolveReferenceUrl(asset, `аудио ${index + 1}`)));
}

async function buildSegmindPayload(req, config) {
  const payload = {
    prompt: req.prompt,
    duration: resolveDuration(req.durationSeconds, config),
    resolution: normalizeResolution(req.resolution, config),
    aspect_ratio: resolveAspectRatio(req.aspectRatio),
  };

  if (typeof req.audio === "boolean") payload.generate_audio = req.audio;

  const options = req.providerOptions ?? {};
  const referenceToVideo = resolveReferenceToVideoMode(config, options);
  if (typeof options.seed === "number" && Number.isFinite(options.seed)) payload.seed = Math.round(options.seed);
  if (typeof options.return_last_frame === "boolean") payload.return_last_frame = options.return_last_frame;
  if (typeof options.skip_moderation === "boolean") payload.skip_moderation = options.skip_moderation;
  if (typeof options.first_frame_url === "string") payload.first_frame_url = await resolveReferenceStringUrl(options.first_frame_url, "первый кадр");
  if (typeof options.last_frame_url === "string") payload.last_frame_url = await resolveReferenceStringUrl(options.last_frame_url, "последний кадр");

  await appendReferenceImages(payload, req.inputImages, { referenceToVideo });
  await appendReferenceVideos(payload, req.inputVideos);
  await appendReferenceAudios(payload, req.inputAudios);

  return payload;
}

async function readTextSafe(response) {
  try {
    const text = await response.text();
    return text.slice(0, 4_000);
  } catch {
    return "";
  }
}

async function assertOk(response, label) {
  if (response.ok) return;
  const body = await readTextSafe(response);
  throw new Error(`${label}: HTTP ${response.status}${body ? `: ${body}` : ""}`);
}

async function readJsonResponse(response, label) {
  await assertOk(response, label);
  try {
    return await response.json();
  } catch (error) {
    throw new Error(`${label}: ответ не является JSON`, { cause: error });
  }
}

function readRequestId(payload) {
  return normalizeOptionalString(payload?.request_id)
    ?? normalizeOptionalString(payload?.requestId)
    ?? normalizeOptionalString(payload?.id);
}

function readStatus(payload) {
  return normalizeOptionalString(payload?.status)
    ?? normalizeOptionalString(payload?.state)
    ?? normalizeOptionalString(payload?.data?.status);
}

function readFailure(payload) {
  return normalizeOptionalString(payload?.error)
    ?? normalizeOptionalString(payload?.message)
    ?? normalizeOptionalString(payload?.detail)
    ?? normalizeOptionalString(payload?.data?.error)
    ?? normalizeOptionalString(payload?.data?.message)
    ?? "Segmind вернул FAILED без подробностей.";
}

function readRemainingCredits(response) {
  const value = normalizeOptionalString(response.headers.get(SEGMIND_REMAINING_CREDITS_HEADER));
  if (!value) return undefined;
  const remainingCredits = Number.parseFloat(value);
  return Number.isFinite(remainingCredits) ? remainingCredits : undefined;
}

function logRemainingCredits(remainingCredits) {
  if (typeof remainingCredits === "number") {
    console.log(`Segmind remaining credits: ${remainingCredits}`);
  }
}

async function pollSegmindRequest({ baseUrl, headers, requestId, statusUrl, timeoutMs, onRemainingCredits }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(statusUrl ?? `${baseUrl}/v2/requests/${requestId}/status`, {
      method: "GET",
      headers,
    });
    const polledRemainingCredits = readRemainingCredits(response);
    if (polledRemainingCredits !== undefined && typeof onRemainingCredits === "function") {
      onRemainingCredits(polledRemainingCredits);
    }
    const payload = await readJsonResponse(response, "Проверка статуса Segmind не удалась");
    const status = readStatus(payload)?.toUpperCase();
    if (status === "COMPLETED" || status === "SUCCEEDED" || status === "SUCCESS") return payload;
    if (status === "FAILED" || status === "ERROR" || status === "CANCELLED") {
      throw new Error(`Segmind не сгенерировал видео: ${readFailure(payload)}`);
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(`Segmind не завершил генерацию за ${Math.round(timeoutMs / 1000)} секунд.`);
}

async function readBufferWithLimit(response, maxBytes, label) {
  await assertOk(response, label);
  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > maxBytes) {
    throw new Error(`${label}: размер ответа ${arrayBuffer.byteLength} байт больше лимита ${maxBytes} байт.`);
  }
  return Buffer.from(arrayBuffer);
}

function findUrl(value) {
  if (typeof value === "string" && /^https?:\/\//iu.test(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findUrl(item);
      if (found) return found;
    }
  }
  if (value && typeof value === "object") {
    for (const key of ["video_url", "videoUrl", "url", "output", "response_url", "responseUrl", "file", "video"]) {
      const found = findUrl(value[key]);
      if (found) return found;
    }
    for (const item of Object.values(value)) {
      const found = findUrl(item);
      if (found) return found;
    }
  }
  return undefined;
}

function findBase64(value) {
  if (typeof value === "string") {
    const dataMatch = /^data:(video\/[^;]+);base64,(.+)$/iu.exec(value);
    if (dataMatch) return { mimeType: dataMatch[1], data: dataMatch[2] };
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findBase64(item);
      if (found) return found;
    }
  }
  if (value && typeof value === "object") {
    for (const key of ["video_base64", "videoBase64", "base64", "b64_json", "b64"]) {
      const data = normalizeOptionalString(value[key]);
      if (data) return { mimeType: "video/mp4", data };
    }
    for (const item of Object.values(value)) {
      const found = findBase64(item);
      if (found) return found;
    }
  }
  return undefined;
}

function shouldSendApiKey(url, baseUrl) {
  try {
    const target = new URL(url);
    const base = new URL(baseUrl);
    return target.hostname === base.hostname;
  } catch {
    return false;
  }
}

async function resolveSegmindApiKey(req) {
  const configured = req.cfg?.plugins?.entries?.segmind?.config?.apiKey;
  const direct = normalizeOptionalString(configured);
  if (direct) return direct;

  const ref = coerceSecretRef(configured);
  if (ref) {
    const values = await resolveSecretRefValues([ref], {
      config: req.cfg,
      env: process.env,
    });
    const value = values.values().next().value;
    return normalizeOptionalString(value);
  }

  return normalizeOptionalString(process.env.SEGMIND_API_KEY);
}

async function downloadVideoUrl({ url, baseUrl, apiKey, maxBytes }) {
  const headers = shouldSendApiKey(url, baseUrl) ? { "x-api-key": apiKey } : {};
  const response = await fetch(url, { method: "GET", headers });
  const mimeType = normalizeOptionalString(response.headers.get("content-type")) ?? "video/mp4";
  const buffer = await readBufferWithLimit(response, maxBytes, "Загрузка результата Segmind не удалась");
  return { buffer, mimeType, sourceUrl: url };
}

function formatSaveError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const limitMatch = /^Media exceeds (\d+MB) limit$/u.exec(message);
  if (limitMatch) return `размер файла больше лимита ${limitMatch[1]}`;
  return message || "неизвестная ошибка";
}

async function saveGeneratedVideoForDelivery({ video, fileName, maxBytes }) {
  let saved;
  try {
    saved = await saveMediaBuffer(
      video.buffer,
      video.mimeType,
      "tool-video-generation",
      maxBytes,
      fileName,
    );
  } catch (error) {
    throw new Error(`Не удалось сохранить результат Segmind в хранилище медиа OpenClaw: ${formatSaveError(error)}`, { cause: error });
  }

  return {
    url: pathToFileURL(saved.path).href,
    mimeType: saved.contentType ?? video.mimeType,
    fileName: path.basename(saved.path),
    metadata: {
      mediaId: saved.id,
      localPath: saved.path,
      size: saved.size,
      ...(video.sourceUrl ? { sourceUrl: video.sourceUrl } : {}),
    },
  };
}

async function readGeneratedVideo({ response, baseUrl, apiKey, maxBytes }) {
  const contentType = normalizeOptionalString(response.headers.get("content-type")) ?? "";
  if (!contentType.includes("json")) {
    return {
      buffer: await readBufferWithLimit(response, maxBytes, "Получение результата Segmind не удалось"),
      mimeType: contentType || "video/mp4",
    };
  }

  const payload = await readJsonResponse(response, "Получение JSON-результата Segmind не удалось");
  const videoUrl = findUrl(payload);
  if (videoUrl) return await downloadVideoUrl({ url: videoUrl, baseUrl, apiKey, maxBytes });

  const base64 = findBase64(payload);
  if (base64) {
    const buffer = Buffer.from(base64.data, "base64");
    if (buffer.byteLength > maxBytes) {
      throw new Error(`Результат Segmind больше лимита ${maxBytes} байт.`);
    }
    return { buffer, mimeType: base64.mimeType ?? "video/mp4" };
  }

  throw new Error("Segmind завершил задачу, но в ответе нет видео, ссылки или base64.");
}

function buildSegmindVideoGenerationProvider() {
  return {
    id: PROVIDER_ID,
    label: "Segmind",
    defaultModel: DEFAULT_MODEL,
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
    models: MODEL_IDS,
    isConfigured: ({ cfg, agentDir }) => {
      void agentDir;
      if (hasConfiguredSecretInput(cfg?.plugins?.entries?.segmind?.config?.apiKey)) return true;
      return Boolean(normalizeOptionalString(process.env.SEGMIND_API_KEY));
    },
    capabilities: buildCapabilities(MODEL_CONFIGS[DEFAULT_MODEL]),
    resolveModelCapabilities: ({ model }) => buildCapabilities(resolveModelConfig(model)),
    async generateVideo(req) {
      const config = resolveModelConfig(req.model);
      const apiKey = await resolveSegmindApiKey(req);
      if (!apiKey) throw new Error("API-ключ Segmind не найден.");

      const baseUrl = resolveBaseUrl(req.cfg);
      const headers = {
        "x-api-key": apiKey,
        "content-type": "application/json",
      };
      const payload = await buildSegmindPayload(req, config);
      const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const submitResponse = await fetch(`${baseUrl}/v2/${config.endpoint}`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      const submitRemainingCredits = readRemainingCredits(submitResponse);
      let latestRemainingCredits = submitRemainingCredits;
      const submitPayload = await readJsonResponse(submitResponse, "Запуск генерации Segmind не удался");
      const requestId = readRequestId(submitPayload);
      if (!requestId) throw new Error("Segmind не вернул request_id.");

      const statusUrl = normalizeOptionalString(submitPayload.status_url) ?? normalizeOptionalString(submitPayload.statusUrl);
      const responseUrl = normalizeOptionalString(submitPayload.response_url)
        ?? normalizeOptionalString(submitPayload.responseUrl)
        ?? `${baseUrl}/v2/requests/${requestId}`;

      const statusPayload = await pollSegmindRequest({
        baseUrl,
        headers: { "x-api-key": apiKey },
        requestId,
        statusUrl,
        timeoutMs,
        onRemainingCredits: (value) => { latestRemainingCredits = value; },
      });

      const resultResponse = await fetch(responseUrl, {
        method: "GET",
        headers: { "x-api-key": apiKey },
      });
      const resultRemainingCredits = readRemainingCredits(resultResponse);
      if (resultRemainingCredits !== undefined) latestRemainingCredits = resultRemainingCredits;
      const remainingCredits = latestRemainingCredits;
      if (remainingCredits !== undefined) logRemainingCredits(remainingCredits);
      const maxBytes = resolveGeneratedVideoMaxBytes(req);
      const video = await readGeneratedVideo({
        response: resultResponse,
        baseUrl,
        apiKey,
        maxBytes,
      });
      const savedVideo = await saveGeneratedVideoForDelivery({
        video,
        fileName: `${config.endpoint}.mp4`,
        maxBytes,
      });

      return {
        videos: [{
          ...savedVideo,
          metadata: {
            ...savedVideo.metadata,
            requestId,
            responseUrl,
            ...(remainingCredits !== undefined ? { remainingCredits } : {}),
          },
        }],
        model: config.endpoint,
        metadata: {
          requestId,
          status: readStatus(statusPayload),
          responseUrl,
          ...(remainingCredits !== undefined ? { remainingCredits } : {}),
        },
      };
    },
  };
}

const plugin = {
  id: "segmind",
  name: "Segmind Video",
  description: "Segmind Seedance 2.0 video generation provider",
  register(api) {
    api.registerVideoGenerationProvider(buildSegmindVideoGenerationProvider());
  },
};

export default plugin;
