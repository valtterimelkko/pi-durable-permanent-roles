/**
 * The Pi coding agent's own model registry and auth, read the way the `pi` CLI does:
 * pi-ai's built-in catalogue, the custom providers and overrides in
 * `<agentDir>/models.json`, and the credentials in `<agentDir>/auth.json`. Adapted from the
 * Phone Steward project, a sibling repository; the role host never writes Pi's files.
 *
 * Read-only by construction. The host process never writes Pi's files: */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	createProvider,
	type AuthContext,
	type Credential,
	type CredentialInfo,
	type CredentialStore,
	type Model,
	type MutableModels,
	type Provider,
	type ProviderStreams,
} from "@earendil-works/pi-ai";
import { builtinModels, getBuiltinModelDataGeneratedAt } from "@earendil-works/pi-ai/providers/all";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";

/** An OAuth token with less than this left is refreshed by pi-ai; we refuse instead. */
const OAUTH_MIN_VALIDITY_MS = 5 * 60 * 1000;

/** `auth.json`, read-only, re-read when its modification time changes. */
export class ReadOnlyAuthFileStore implements CredentialStore {
	readonly #path: string;
	#cache: { mtimeMs: number; size: number; data: Record<string, Credential> } | undefined;

	constructor(path: string) {
		this.#path = path;
	}

	#load(): Record<string, Credential> {
		let info: ReturnType<typeof statSync>;
		try {
			info = statSync(this.#path);
		} catch {
			this.#cache = undefined;
			return {};
		}
		if (this.#cache !== undefined && this.#cache.mtimeMs === info.mtimeMs && this.#cache.size === info.size) {
			return this.#cache.data;
		}
		let data: Record<string, Credential> = {};
		try {
			const parsed: unknown = JSON.parse(readFileSync(this.#path, "utf8"));
			if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
				data = parsed as Record<string, Credential>;
			}
		} catch {
			data = {};
		}
		this.#cache = { mtimeMs: info.mtimeMs, size: info.size, data };
		return data;
	}

	async read(providerId: string): Promise<Credential | undefined> {
		const entry = this.#load()[providerId];
		return entry !== undefined && typeof entry === "object" && (entry.type === "api_key" || entry.type === "oauth")
			? entry
			: undefined;
	}

	async list(): Promise<readonly CredentialInfo[]> {
		const out: CredentialInfo[] = [];
		for (const [providerId, entry] of Object.entries(this.#load())) {
			if (entry !== null && typeof entry === "object" && (entry.type === "api_key" || entry.type === "oauth")) {
				out.push({ providerId, type: entry.type });
			}
		}
		return out;
	}

	/**
	 * pi-ai calls this to refresh OAuth tokens (and to save logins). We never write. The
	 * callback runs only when it cannot change the credential: a healthy token.
	 */
	async modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined> {
		const current = await this.read(providerId);
		if (current?.type === "oauth" && Date.now() + OAUTH_MIN_VALIDITY_MS >= current.expires) {
			throw new Error(
				`the stored ${providerId} login is expired or about to expire; the host does not refresh Pi's tokens (run pi once to refresh it)`,
			);
		}
		await fn(current);
		return current;
	}

	async delete(_providerId?: string): Promise<void> {
		// Read-only: a logout is the pi CLI's job.
	}
}

/** `models-store.json`, read-only, re-read when its modification time changes (A15.4). */
export class ReadOnlyModelsStoreFile {
	readonly #path: string;
	#cache: { mtimeMs: number; size: number; data: Record<string, unknown>; ok: boolean } | undefined;

	constructor(path: string) {
		this.#path = path;
	}

	/** The parsed store, or undefined when there is no readable file. `ok` is false when the file exists but is not valid JSON. */
	#load(): { data: Record<string, unknown>; ok: boolean } | undefined {
		let info: ReturnType<typeof statSync>;
		try {
			info = statSync(this.#path);
		} catch {
			this.#cache = undefined;
			return undefined;
		}
		if (this.#cache !== undefined && this.#cache.mtimeMs === info.mtimeMs && this.#cache.size === info.size) {
			return this.#cache;
		}
		let ok = false;
		let data: Record<string, unknown> = {};
		try {
			// pi strips a BOM before parsing (pi-coding-agent dist/core/models-store.js).
			const text = readFileSync(this.#path, "utf8").replace(/^\uFEFF/, "");
			const parsed: unknown = JSON.parse(text);
			if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
				data = parsed as Record<string, unknown>;
				ok = true;
			}
		} catch {
			ok = false;
		}
		this.#cache = { mtimeMs: info.mtimeMs, size: info.size, data, ok };
		return this.#cache;
	}

	/** One provider's overlay entry (the raw parsed value), or undefined. */
	entry(providerId: string): unknown {
		return this.#load()?.data[providerId];
	}

	/** True when the file exists but could not be parsed (or holds no object). */
	broken(): boolean {
		const loaded = this.#load();
		return loaded !== undefined && !loaded.ok;
	}

	/** Human-readable problems in the current file (advisory; never a secret). */
	problems(): string[] {
		const loaded = this.#load();
		if (loaded === undefined) return [];
		if (!loaded.ok) return ["models-store.json is not valid JSON; only the built-in catalogue is offered"];
		const out: string[] = [];
		for (const [providerId, entry] of Object.entries(loaded.data)) {
			if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
				out.push(`models-store.json: entry for ${providerId} is not an object; ignored`);
				continue;
			}
			const models = (entry as Record<string, unknown>).models;
			if (models !== undefined && !Array.isArray(models)) {
				out.push(`models-store.json: entry for ${providerId} has a malformed models list; ignored`);
			}
		}
		return out;
	}
}

const KNOWN_MODEL_TYPES = new Set(["chat", "image", "classifier"]);

/** pi-ai `getModelType`: undefined reads as chat; an unknown type is dropped by `withKnownModelTypes`. */
function storedModelType(model: Record<string, unknown>): string | undefined {
	if (model.type === undefined) return "chat";
	return typeof model.type === "string" && KNOWN_MODEL_TYPES.has(model.type) ? model.type : undefined;
}

function isStoredModel(value: unknown): value is Record<string, unknown> & { id: string } {
	return typeof value === "object" && value !== null && !Array.isArray(value) && typeof (value as Record<string, unknown>).id === "string";
}

/**
 * pi's freshness gate (pi-coding-agent dist/core/remote-catalog-provider.js `remoteModels`):
 * a stored entry older than the built-in catalogue's data is ignored wholesale.
 */
function storedOverlayModels(entry: unknown, providerId: string, generatedAt: number | undefined): Model<never>[] {
	if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return [];
	const lastModified = (entry as Record<string, unknown>).lastModified;
	if (generatedAt !== undefined && (typeof lastModified !== "number" || lastModified <= generatedAt)) return [];
	const models = (entry as Record<string, unknown>).models;
	if (!Array.isArray(models)) return [];
	return models.filter(
		(model): model is Model<never> => isStoredModel(model) && storedModelType(model) !== undefined && model.provider === providerId,
	) as Model<never>[];
}

/** pi's merge (remote-catalog-provider.js `mergeModels`): later entries win per type and id. */
function mergeStoredModels(baseline: readonly Model<never>[], dynamic: readonly Model<never>[]): Model<never>[] {
	const merged = new Map<string, Model<never>>();
	for (const model of [...baseline, ...dynamic]) {
		merged.set(`${storedModelType(model as unknown as Record<string, unknown>) ?? "chat"}\u0000${model.id}`, model);
	}
	return [...merged.values()];
}

/**
 * The read-only overlay the `pi` CLI's remotely refreshed catalogue adds to a built-in
 * provider (A15.4). Mirrors pi-coding-agent dist/core/remote-catalog-provider.js's
 * `withRemoteCatalog` without the network half: the file is refreshed by the owner's pi
 * CLI, never by the host. `readEntry` runs per getModels call, so a changed file is
 * picked up without a restart.
 */
function withStoreOverlay(base: Provider, readEntry: () => unknown, generatedAt: number | undefined): Provider {
	const dynamicAll = (): Model<never>[] => storedOverlayModels(readEntry(), base.id, generatedAt);
	return {
		...base,
		getModels: () => mergeStoredModels(base.getModels() as readonly Model<never>[], dynamicAll().filter((m) => (storedModelType(m as unknown as Record<string, unknown>) ?? "chat") === "chat")) as never,
		...(base.getAllModels === undefined
			? {}
			: { getAllModels: () => mergeStoredModels(base.getAllModels!() as readonly Model<never>[], dynamicAll()) as never }),
	};
}

export type HostModelsOptions = {
	/** Pi's agent dir; default `~/.pi/agent` (`STANDING_ROLES_PI_DIR`). */
	agentDir: string;
	/** Test hook: the ambient environment for provider auth. Default: `process.env`. */
	authContext?: AuthContext;
};

export type HostModels = {
	models: MutableModels;
	credentials: CredentialStore;
	/** Human-readable problems that did not stop the catalogue loading; never a secret. */
	problems: string[];
};

type ModelDef = {
	id?: unknown;
	name?: unknown;
	api?: unknown;
	baseUrl?: unknown;
	reasoning?: unknown;
	input?: unknown;
	contextWindow?: unknown;
	maxTokens?: unknown;
	headers?: unknown;
};
type ProviderCfg = {
	name?: unknown;
	baseUrl?: unknown;
	apiKey?: unknown;
	api?: unknown;
	headers?: unknown;
	models?: unknown;
	modelOverrides?: unknown;
};

const API_STREAMS: Record<string, () => ProviderStreams> = {
	"openai-completions": openAICompletionsApi,
	"openai-responses": openAIResponsesApi,
	"anthropic-messages": anthropicMessagesApi,
};

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}
function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}
function headersOf(value: unknown): Record<string, string> | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const out: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) if (typeof entry === "string") out[key] = entry;
	return Object.keys(out).length === 0 ? undefined : out;
}

/** Build one custom `Model` from a models.json definition, or undefined when it lacks an id/api. */
function customModel(providerId: string, cfg: ProviderCfg, def: ModelDef): Model<never> | undefined {
	const id = str(def.id);
	const api = str(def.api) ?? str(cfg.api);
	const baseUrl = str(def.baseUrl) ?? str(cfg.baseUrl);
	if (id === undefined || api === undefined || baseUrl === undefined) return undefined;
	const input = Array.isArray(def.input) && def.input.every((v) => v === "text" || v === "image") ? def.input : ["text"];
	return {
		id,
		name: str(def.name) ?? id,
		api,
		provider: providerId,
		baseUrl,
		input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: def.reasoning === true,
		contextWindow: num(def.contextWindow) ?? 128_000,
		maxTokens: num(def.maxTokens) ?? 16_384,
		...(headersOf(def.headers) === undefined ? {} : { headers: headersOf(def.headers) }),
	} as unknown as Model<never>;
}

/** Apply a `modelOverrides` entry (the fields Pi allows that matter here) to a model. */
function overridden<T extends Model<never>>(model: T, overrides: unknown): T {
	if (overrides === null || typeof overrides !== "object") return model;
	const o = (overrides as Record<string, ModelDef>)[model.id];
	if (o === undefined || o === null || typeof o !== "object") return model;
	return {
		...model,
		...(str(o.name) === undefined ? {} : { name: str(o.name) }),
		...(typeof o.reasoning === "boolean" ? { reasoning: o.reasoning } : {}),
		...(num(o.contextWindow) === undefined ? {} : { contextWindow: num(o.contextWindow) }),
		...(num(o.maxTokens) === undefined ? {} : { maxTokens: num(o.maxTokens) }),
	};
}

/** A provider that serves the base provider's models with Pi's overrides and extra models. */
function overlayProvider(base: Provider, cfg: ProviderCfg, extra: Model<never>[]): Provider {
	const apply = (): readonly Model<never>[] => {
		const own = base.getModels() as readonly Model<never>[];
		const known = new Set(own.map((m) => m.id));
		return [...own.map((m) => overridden(m, cfg.modelOverrides)), ...extra.filter((m) => !known.has(m.id))];
	};
	return {
		id: base.id,
		name: base.name,
		...(base.baseUrl === undefined ? {} : { baseUrl: base.baseUrl }),
		...(base.headers === undefined ? {} : { headers: base.headers }),
		auth: base.auth,
		getModels: () => apply() as never,
		...(base.refreshModels === undefined ? {} : { refreshModels: (ctx) => base.refreshModels!(ctx) }),
		...(base.filterModels === undefined ? {} : { filterModels: (models, credential) => base.filterModels!(models, credential) }),
		stream: (model, context, options) => base.stream(model, context, options),
		streamSimple: (model, context, options) => base.streamSimple(model, context, options),
	};
}

/** A brand-new provider from a models.json entry, or undefined when none of its models is usable. */
function customProvider(providerId: string, cfg: ProviderCfg, problems: string[]): Provider | undefined {
	const defs = Array.isArray(cfg.models) ? (cfg.models as ModelDef[]) : [];
	const usable: Model<never>[] = [];
	const apis = new Set<string>();
	for (const def of defs) {
		const model = customModel(providerId, cfg, def);
		if (model === undefined) continue;
		if (API_STREAMS[model.api as string] === undefined) {
			problems.push(`models.json: provider ${providerId} model ${model.id} uses an unsupported api (${String(model.api)}); skipped`);
			continue;
		}
		usable.push(overridden(model, cfg.modelOverrides));
		apis.add(model.api as string);
	}
	if (usable.length === 0) return undefined;
	const configured = str(cfg.apiKey);
	const api: Record<string, ProviderStreams> = {};
	for (const name of apis) api[name] = API_STREAMS[name]!();
	return createProvider({
		id: providerId,
		name: str(cfg.name) ?? providerId,
		...(str(cfg.baseUrl) === undefined ? {} : { baseUrl: str(cfg.baseUrl) }),
		auth: {
			apiKey: {
				name: `${providerId} API key`,
				resolve: async ({ ctx, credential }) => {
					if (credential?.key) return { auth: { apiKey: credential.key }, source: "stored credential" };
					// A leading "!" is a shell command in Pi: never executed here.
					if (configured === undefined || configured.startsWith("!")) return undefined;
					const fromEnv = await ctx.env(configured);
					return { auth: { apiKey: fromEnv ?? configured }, source: fromEnv !== undefined ? configured : "models.json" };
				},
			},
		},
		models: usable as never,
		api: api as never,
	}) as Provider;
}

function readModelsJson(path: string, problems: string[]): Record<string, ProviderCfg> {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") problems.push("models.json could not be read");
		return {};
	}
	try {
		const parsed = JSON.parse(text) as { providers?: Record<string, ProviderCfg> };
		if (parsed === null || typeof parsed !== "object" || parsed.providers === null || typeof parsed.providers !== "object") {
			problems.push("models.json has no providers object");
			return {};
		}
		return parsed.providers;
	} catch {
		problems.push("models.json is not valid JSON; only the built-in catalogue is offered");
		return {};
	}
}

/** The registry the host's harness uses: Pi's catalogue, overrides and auth. */
export async function buildHostModels(options: HostModelsOptions): Promise<HostModels> {
	const problems: string[] = [];
	const credentials = new ReadOnlyAuthFileStore(join(options.agentDir, "auth.json"));
	const models = builtinModels({
		credentials,
		...(options.authContext === undefined ? {} : { authContext: options.authContext }),
	});
	// A15.4: the remotely refreshed catalogue overlay (models-store.json), read-only, merged
	// exactly the way the pi CLI merges it: an entry newer than the built-in catalogue's data
	// replaces the built-in models of the same ids. Re-read on change, like auth.json.
	const store = new ReadOnlyModelsStoreFile(join(options.agentDir, "models-store.json"));
	problems.push(...store.problems());
	const generatedAt = getBuiltinModelDataGeneratedAt();
	for (const provider of models.getProviders()) {
		models.setProvider(withStoreOverlay(provider, () => store.entry(provider.id), generatedAt));
	}
	const providers = readModelsJson(join(options.agentDir, "models.json"), problems);
	for (const [providerId, cfg] of Object.entries(providers)) {
		if (cfg === null || typeof cfg !== "object") continue;
		const existing = models.getProvider(providerId);
		if (existing !== undefined) {
			const extra: Model<never>[] = [];
			for (const def of Array.isArray(cfg.models) ? (cfg.models as ModelDef[]) : []) {
				const model = customModel(providerId, cfg, def);
				if (model !== undefined) extra.push(overridden(model, cfg.modelOverrides));
			}
			models.setProvider(overlayProvider(existing, cfg, extra));
			continue;
		}
		const created = customProvider(providerId, cfg, problems);
		if (created !== undefined) models.setProvider(created);
	}
	return { models, credentials, problems };
}
