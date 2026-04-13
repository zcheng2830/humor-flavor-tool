"use client";

import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import Image from "next/image";
import { getSupabaseBrowserClient } from "@/lib/supabase-client";
import { isGoogleUser } from "@/lib/auth/google";
import type { CaptionRun, FlavorWithSteps, HumorFlavorStep, Profile, ThemeMode } from "@/lib/types";
import type { Session, SupabaseClient } from "@supabase/supabase-js";

const ALMOSTCRACKD_API_BASE_URL = (
  process.env.NEXT_PUBLIC_ALMOSTCRACKD_API_BASE_URL ?? "https://api.almostcrackd.ai"
).replace(/\/+$/, "");

const SUPPORTED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
]);

const THEME_STORAGE_KEY = "humor-flavor-tool-theme-mode";
const LOCAL_CAPTION_RUNS_STORAGE_PREFIX = "humor-flavor-tool-local-caption-runs";
const STEP_TEMPLATE_SUGGESTIONS = [
  {
    title: "Describe image",
    prompt:
      "Describe the image literally. Identify the people/objects, visible actions, expressions, and any odd details.",
  },
  {
    title: "Find funny angle",
    prompt:
      "Based on the description, identify the funniest contrast, mismatch, or awkward moment. Keep it specific to this image.",
  },
  {
    title: "Generate 5 captions",
    prompt:
      "Write 5 short, punchy captions from the funny angle. Keep each caption under 16 words and avoid repeating phrasing.",
  },
] as const;

interface FlavorRow {
  id: string | number;
  name?: string | null;
  slug?: string | null;
  description?: string | null;
  created_by?: string | null;
  created_by_user_id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  created_datetime_utc?: string | null;
  modified_datetime_utc?: string | null;
}

interface StepRow {
  id: string | number;
  humor_flavor_id: string | number;
  title?: string | null;
  prompt?: string | null;
  description?: string | null;
  llm_user_prompt?: string | null;
  llm_system_prompt?: string | null;
  step_order?: number | null;
  order_by?: number | null;
  created_at?: string | null;
  updated_at?: string | null;
  created_datetime_utc?: string | null;
  modified_datetime_utc?: string | null;
}

interface CaptionRunRow {
  id: string | number;
  humor_flavor_id: string | number;
  image_name?: string | null;
  image_id: string;
  captions: unknown;
  raw_response: unknown;
  created_at?: string | null;
  created_datetime_utc?: string | null;
}

interface StepDraft {
  title: string;
  prompt: string;
}

interface TestImageFile {
  id: string;
  file: File;
  previewUrl: string;
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return fallback;
}

function extractApiError(payload: unknown) {
  if (payload && typeof payload === "object") {
    const maybeMessage = "message" in payload ? payload.message : null;
    if (typeof maybeMessage === "string" && maybeMessage.trim().length > 0) {
      return maybeMessage;
    }

    const maybeStatusMessage = "statusMessage" in payload ? payload.statusMessage : null;
    if (typeof maybeStatusMessage === "string" && maybeStatusMessage.trim().length > 0) {
      return maybeStatusMessage;
    }
  }

  return null;
}

async function safeJson(response: Response) {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? item.trim() : String(item).trim()))
      .filter(Boolean);
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return [];
    }

    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        return parsed
          .map((item) => (typeof item === "string" ? item.trim() : String(item).trim()))
          .filter(Boolean);
      }
    } catch {
      return [trimmed];
    }
  }

  return [];
}

function extractCaptions(payload: unknown): string[] {
  if (!payload) {
    return [];
  }

  if (typeof payload === "string") {
    const trimmed = payload.trim();
    return trimmed ? [trimmed] : [];
  }

  if (Array.isArray(payload)) {
    const captions = payload.flatMap((item) => {
      if (typeof item === "string") {
        return item.trim() ? [item.trim()] : [];
      }

      if (item && typeof item === "object") {
        const record = item as Record<string, unknown>;
        const direct =
          (typeof record.caption === "string" && record.caption.trim()) ||
          (typeof record.text === "string" && record.text.trim()) ||
          (typeof record.output === "string" && record.output.trim()) ||
          (typeof record.generated_caption === "string" && record.generated_caption.trim());
        if (direct) {
          return [direct];
        }

        if (Array.isArray(record.captions)) {
          return record.captions
            .map((entry) => (typeof entry === "string" ? entry.trim() : String(entry).trim()))
            .filter(Boolean);
        }
      }

      return [];
    });

    return captions;
  }

  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    if (Array.isArray(record.captions)) {
      return record.captions
        .map((entry) => (typeof entry === "string" ? entry.trim() : String(entry).trim()))
        .filter(Boolean);
    }
  }

  return [];
}

function isMissingColumnError(error: { code?: string | null; message?: string | null } | null) {
  if (!error) {
    return false;
  }
  return (
    error.code === "42703" ||
    Boolean(error.message?.includes("does not exist")) ||
    Boolean(error.message?.includes("schema cache"))
  );
}

function isMissingTableError(error: { code?: string | null; message?: string | null } | null) {
  if (!error) {
    return false;
  }
  return (
    error.code === "PGRST205" ||
    Boolean(error.message?.includes("Could not find the table")) ||
    Boolean(error.message?.includes("schema cache"))
  );
}

function toIsoTimestamp(...values: Array<string | null | undefined>) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return new Date().toISOString();
}

function getLocalCaptionRunsStorageKey(userId: string, flavorId: string) {
  return `${LOCAL_CAPTION_RUNS_STORAGE_PREFIX}:${userId}:${flavorId}`;
}

function readLocalCaptionRuns(userId: string, flavorId: string): CaptionRun[] {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(getLocalCaptionRunsStorageKey(userId, flavorId));
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    const runs: CaptionRun[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const row = item as Record<string, unknown>;
      const id = typeof row.id === "string" ? row.id : null;
      const imageId = typeof row.image_id === "string" ? row.image_id : null;
      if (!id || !imageId) {
        continue;
      }

      runs.push({
        id,
        humor_flavor_id:
          typeof row.humor_flavor_id === "string" ? row.humor_flavor_id : flavorId,
        image_name: typeof row.image_name === "string" ? row.image_name : imageId,
        image_id: imageId,
        captions: toStringArray(row.captions),
        raw_response: row.raw_response ?? null,
        created_at: toIsoTimestamp(typeof row.created_at === "string" ? row.created_at : null),
      });
    }

    return runs.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  } catch {
    return [];
  }
}

function saveLocalCaptionRun(userId: string, run: CaptionRun) {
  if (typeof window === "undefined") {
    return;
  }

  const existing = readLocalCaptionRuns(userId, run.humor_flavor_id);
  const deduped = [run, ...existing.filter((item) => item.id !== run.id)];
  const sorted = deduped.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  window.localStorage.setItem(
    getLocalCaptionRunsStorageKey(userId, run.humor_flavor_id),
    JSON.stringify(sorted.slice(0, 100)),
  );
}

function removeLocalCaptionRuns(userId: string, flavorIds: string[]) {
  if (typeof window === "undefined") {
    return;
  }
  for (const flavorId of flavorIds) {
    window.localStorage.removeItem(getLocalCaptionRunsStorageKey(userId, flavorId));
  }
}

function mergeCaptionRuns(primaryRuns: CaptionRun[], localRuns: CaptionRun[]) {
  const byId = new Map<string, CaptionRun>();
  for (const run of primaryRuns) {
    byId.set(run.id, run);
  }
  for (const run of localRuns) {
    if (!byId.has(run.id)) {
      byId.set(run.id, run);
    }
  }
  return Array.from(byId.values()).sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
}

async function fetchOrderedStepRows(
  supabase: SupabaseClient,
  flavorId: string,
): Promise<Array<{ id: string; step_order: number }>> {
  const primary = await supabase
    .from("humor_flavor_steps")
    .select("id, step_order")
    .eq("humor_flavor_id", flavorId)
    .order("step_order", { ascending: true });

  if (!primary.error) {
    return ((primary.data ?? []) as Array<{ id: string | number; step_order: number | null }>).map(
      (step, index) => ({
        id: String(step.id),
        step_order: typeof step.step_order === "number" ? step.step_order : index + 1,
      }),
    );
  }

  if (!isMissingColumnError(primary.error)) {
    throw new Error(primary.error.message);
  }

  const fallback = await supabase
    .from("humor_flavor_steps")
    .select("id, order_by")
    .eq("humor_flavor_id", flavorId)
    .order("order_by", { ascending: true });

  if (fallback.error) {
    throw new Error(fallback.error.message);
  }

  return ((fallback.data ?? []) as Array<{ id: string | number; order_by: number | null }>).map(
    (step, index) => ({
      id: String(step.id),
      step_order: typeof step.order_by === "number" ? step.order_by : index + 1,
    }),
  );
}

async function persistStepOrder(
  supabase: SupabaseClient,
  stepId: string,
  nextOrder: number,
) {
  const primary = await supabase
    .from("humor_flavor_steps")
    .update({ step_order: nextOrder })
    .eq("id", stepId);

  if (!primary.error) {
    return null;
  }

  if (!isMissingColumnError(primary.error)) {
    return primary.error;
  }

  const fallback = await supabase
    .from("humor_flavor_steps")
    .update({ order_by: nextOrder })
    .eq("id", stepId);

  return fallback.error ?? null;
}

async function fetchFlavorsWithSteps(
  supabase: SupabaseClient,
  userId: string,
) {
  const flavorQueryAttempts = [
    {
      select: "id, name, description, created_by, created_at, updated_at",
      ownerColumn: "created_by" as const,
      orderColumn: "created_at" as const,
    },
    {
      select: "id, name, description, created_by_user_id, created_at, updated_at",
      ownerColumn: "created_by_user_id" as const,
      orderColumn: "created_at" as const,
    },
    {
      select: "id, slug, description, created_by_user_id, created_datetime_utc, modified_datetime_utc",
      ownerColumn: "created_by_user_id" as const,
      orderColumn: "created_datetime_utc" as const,
    },
    {
      select: "id, slug, description, created_by, created_datetime_utc, modified_datetime_utc",
      ownerColumn: "created_by" as const,
      orderColumn: "created_datetime_utc" as const,
    },
  ];

  let flavors: FlavorRow[] | null = null;
  for (const attempt of flavorQueryAttempts) {
    const response = await supabase
      .from("humor_flavors")
      .select(attempt.select)
      .eq(attempt.ownerColumn, userId)
      .order(attempt.orderColumn, { ascending: false });

    if (response.error) {
      if (isMissingColumnError(response.error)) {
        continue;
      }
      throw new Error(response.error.message);
    }

    flavors = (response.data ?? []) as unknown as FlavorRow[];
    break;
  }

  if (!flavors) {
    return [];
  }

  const flavorIds = flavors.map((row) => String(row.id));
  if (!flavorIds.length) {
    return [];
  }

  let steps: StepRow[] = [];
  const primaryStepsResponse = await supabase
    .from("humor_flavor_steps")
    .select("id, humor_flavor_id, title, prompt, step_order, created_at, updated_at")
    .in("humor_flavor_id", flavorIds)
    .order("step_order", { ascending: true });

  if (primaryStepsResponse.error) {
    if (!isMissingColumnError(primaryStepsResponse.error)) {
      throw new Error(primaryStepsResponse.error.message);
    }

    const fallbackStepsResponse = await supabase
      .from("humor_flavor_steps")
      .select(
        "id, humor_flavor_id, description, llm_user_prompt, llm_system_prompt, order_by, created_datetime_utc, modified_datetime_utc",
      )
      .in("humor_flavor_id", flavorIds)
      .order("order_by", { ascending: true });

    if (fallbackStepsResponse.error) {
      throw new Error(fallbackStepsResponse.error.message);
    }

    steps = (fallbackStepsResponse.data ?? []) as StepRow[];
  } else {
    steps = (primaryStepsResponse.data ?? []) as StepRow[];
  }

  const stepsByFlavor = new Map<string, HumorFlavorStep[]>();
  for (const rawStep of steps) {
    const flavorId = String(rawStep.humor_flavor_id);
    const current = stepsByFlavor.get(flavorId) ?? [];
    const stepOrder =
      typeof rawStep.step_order === "number"
        ? rawStep.step_order
        : typeof rawStep.order_by === "number"
          ? rawStep.order_by
          : current.length + 1;
    const title =
      (typeof rawStep.title === "string" && rawStep.title.trim()) ||
      (typeof rawStep.description === "string" && rawStep.description.trim()) ||
      `Step ${stepOrder}`;
    const prompt =
      (typeof rawStep.prompt === "string" && rawStep.prompt.trim()) ||
      (typeof rawStep.llm_user_prompt === "string" && rawStep.llm_user_prompt.trim()) ||
      (typeof rawStep.llm_system_prompt === "string" && rawStep.llm_system_prompt.trim()) ||
      "";

    current.push({
      id: String(rawStep.id),
      humor_flavor_id: flavorId,
      title,
      prompt,
      step_order: stepOrder,
      created_at: toIsoTimestamp(rawStep.created_at, rawStep.created_datetime_utc),
      updated_at: toIsoTimestamp(rawStep.updated_at, rawStep.modified_datetime_utc),
    });
    stepsByFlavor.set(flavorId, current);
  }

  return flavors.map<FlavorWithSteps>((rawFlavor) => {
    const flavorId = String(rawFlavor.id);
    const displayName =
      (typeof rawFlavor.name === "string" && rawFlavor.name.trim()) ||
      (typeof rawFlavor.slug === "string" && rawFlavor.slug.trim()) ||
      `Flavor ${flavorId}`;

    return {
      id: flavorId,
      name: displayName,
      description: rawFlavor.description ?? null,
      created_at: toIsoTimestamp(rawFlavor.created_at, rawFlavor.created_datetime_utc),
      updated_at: toIsoTimestamp(
        rawFlavor.updated_at,
        rawFlavor.modified_datetime_utc,
        rawFlavor.created_at,
        rawFlavor.created_datetime_utc,
      ),
      steps: (stepsByFlavor.get(flavorId) ?? []).sort((a, b) => a.step_order - b.step_order),
    };
  });
}

async function fetchCaptionRuns(supabase: SupabaseClient, flavorId: string) {
  const primaryResponse = await supabase
    .from("humor_flavor_caption_runs")
    .select("id, humor_flavor_id, image_name, image_id, captions, raw_response, created_at")
    .eq("humor_flavor_id", flavorId)
    .order("created_at", { ascending: false });

  if (primaryResponse.error) {
    if (primaryResponse.error.code === "PGRST205") {
      return [];
    }

    if (!isMissingColumnError(primaryResponse.error)) {
      throw new Error(primaryResponse.error.message);
    }

    const fallbackResponse = await supabase
      .from("humor_flavor_caption_runs")
      .select("id, humor_flavor_id, image_name, image_id, captions, raw_response, created_datetime_utc")
      .eq("humor_flavor_id", flavorId)
      .order("created_datetime_utc", { ascending: false });

    if (fallbackResponse.error) {
      return [];
    }

    const fallbackRows = (fallbackResponse.data ?? []) as CaptionRunRow[];
    return fallbackRows.map<CaptionRun>((row) => ({
      id: String(row.id),
      humor_flavor_id: String(row.humor_flavor_id),
      image_name: row.image_name ?? row.image_id,
      image_id: row.image_id,
      captions: toStringArray(row.captions),
      raw_response: row.raw_response,
      created_at: toIsoTimestamp(row.created_at, row.created_datetime_utc),
    }));
  }

  const rows = (primaryResponse.data ?? []) as CaptionRunRow[];
  return rows.map<CaptionRun>((row) => ({
    id: String(row.id),
    humor_flavor_id: String(row.humor_flavor_id),
    image_name: row.image_name ?? row.image_id,
    image_id: row.image_id,
    captions: toStringArray(row.captions),
    raw_response: row.raw_response,
    created_at: toIsoTimestamp(row.created_at, row.created_datetime_utc),
  }));
}

function isAdminProfile(profile: Profile | null) {
  return Boolean(profile?.is_superadmin || profile?.is_matrix_admin);
}

function createId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function toFlavorSlug(name: string) {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);

  return slug || `flavor-${Date.now()}`;
}

async function deleteFlavorsByIds(
  supabase: SupabaseClient,
  flavorIds: string[],
) {
  if (!flavorIds.length) {
    return null;
  }

  const runsDeleteResponse = await supabase
    .from("humor_flavor_caption_runs")
    .delete()
    .in("humor_flavor_id", flavorIds);
  if (runsDeleteResponse.error && runsDeleteResponse.error.code !== "PGRST205") {
    return runsDeleteResponse.error.message;
  }

  const stepsDeleteResponse = await supabase
    .from("humor_flavor_steps")
    .delete()
    .in("humor_flavor_id", flavorIds);
  if (stepsDeleteResponse.error && stepsDeleteResponse.error.code !== "PGRST205") {
    return stepsDeleteResponse.error.message;
  }

  const flavorDeleteResponse = await supabase.from("humor_flavors").delete().in("id", flavorIds);
  if (flavorDeleteResponse.error && flavorDeleteResponse.error.code !== "PGRST205") {
    return flavorDeleteResponse.error.message;
  }

  return null;
}

function resolveAuthRedirectOrigin() {
  const configuredOrigin = process.env.NEXT_PUBLIC_AUTH_REDIRECT_ORIGIN?.trim();

  if (!configuredOrigin) {
    return window.location.origin;
  }

  try {
    const parsed = new URL(configuredOrigin);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return window.location.origin;
    }
    return parsed.origin;
  } catch {
    return window.location.origin;
  }
}

export default function HumorFlavorApp() {
  const [supabase, setSupabase] = useState<SupabaseClient | null>(null);
  const [envError, setEnvError] = useState<string | null>(null);

  const [session, setSession] = useState<Session | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [isSigningIn, setIsSigningIn] = useState(false);

  const [profile, setProfile] = useState<Profile | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);

  const [themeMode, setThemeMode] = useState<ThemeMode>("system");

  const [flavors, setFlavors] = useState<FlavorWithSteps[]>([]);
  const [selectedFlavorId, setSelectedFlavorId] = useState<string | null>(null);
  const [dataLoading, setDataLoading] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);
  const [dataRefreshToken, setDataRefreshToken] = useState(0);

  const [newFlavorName, setNewFlavorName] = useState("");
  const [newFlavorDescription, setNewFlavorDescription] = useState("");
  const [isCreatingFlavor, setIsCreatingFlavor] = useState(false);

  const [flavorDraftName, setFlavorDraftName] = useState("");
  const [flavorDraftDescription, setFlavorDraftDescription] = useState("");
  const [isSavingFlavor, setIsSavingFlavor] = useState(false);
  const [isDeletingFlavor, setIsDeletingFlavor] = useState(false);
  const [isDeletingAllFlavors, setIsDeletingAllFlavors] = useState(false);

  const [stepDrafts, setStepDrafts] = useState<Record<string, StepDraft>>({});
  const [newStepTitle, setNewStepTitle] = useState("");
  const [newStepPrompt, setNewStepPrompt] = useState("");
  const [stepSavingState, setStepSavingState] = useState<Record<string, boolean>>({});
  const [isCreatingStep, setIsCreatingStep] = useState(false);
  const [isReorderingStep, setIsReorderingStep] = useState(false);

  const [testFiles, setTestFiles] = useState<TestImageFile[]>([]);
  const [selectedTestFileId, setSelectedTestFileId] = useState<string | null>(null);
  const fileCacheRef = useRef<TestImageFile[]>([]);

  const [pipelineStatus, setPipelineStatus] = useState<string | null>(null);
  const [pipelineError, setPipelineError] = useState<string | null>(null);
  const [pipelineWarning, setPipelineWarning] = useState<string | null>(null);
  const [isGeneratingCaptions, setIsGeneratingCaptions] = useState(false);
  const [latestCaptions, setLatestCaptions] = useState<string[]>([]);
  const [latestRawResponse, setLatestRawResponse] = useState<unknown>(null);

  const [captionRuns, setCaptionRuns] = useState<CaptionRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [runsRefreshToken, setRunsRefreshToken] = useState(0);

  const selectedFlavor = flavors.find((flavor) => flavor.id === selectedFlavorId) ?? null;
  const selectedSteps = [...(selectedFlavor?.steps ?? [])].sort((a, b) => a.step_order - b.step_order);
  const selectedTestFile = testFiles.find((entry) => entry.id === selectedTestFileId) ?? null;
  const userIsAdmin = isAdminProfile(profile);

  useEffect(() => {
    try {
      setSupabase(getSupabaseBrowserClient());
      setEnvError(null);
    } catch (error) {
      setEnvError(getErrorMessage(error, "Failed to initialize Supabase client."));
    }
  }, []);

  useEffect(() => {
    if (!supabase) {
      return;
    }

    let active = true;
    setAuthLoading(true);

    void supabase.auth.getSession().then(({ data, error }) => {
      if (!active) {
        return;
      }
      if (error) {
        setAuthError(error.message);
      } else {
        setSession(data.session ?? null);
      }
      setAuthLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      if (nextSession) {
        setAuthError(null);
      }
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [supabase]);

  useEffect(() => {
    if (!supabase || !session) {
      return;
    }

    if (isGoogleUser(session.user)) {
      return;
    }

    let active = true;
    setAuthError("Google authentication is required for this tool.");

    void supabase.auth.signOut().then(({ error }) => {
      if (!active || !error) {
        return;
      }
      setAuthError(error.message);
    });

    return () => {
      active = false;
    };
  }, [session, supabase]);

  useEffect(() => {
    if (!supabase) {
      return;
    }

    if (!session) {
      setProfile(null);
      setProfileError(null);
      setProfileLoading(false);
      return;
    }

    let active = true;
    setProfileLoading(true);
    setProfileError(null);

    void supabase
      .from("profiles")
      .select("id, email, is_superadmin, is_matrix_admin")
      .eq("id", session.user.id)
      .maybeSingle()
      .then(({ data, error }) => {
        if (!active) {
          return;
        }

        if (error) {
          setProfileError(error.message);
          setProfile(null);
        } else if (!data) {
          setProfileError("No profile found for this user.");
          setProfile(null);
        } else {
          const profileData = data as Profile;
          setProfile({
            id: profileData.id,
            email: profileData.email ?? session.user.email ?? null,
            is_superadmin: Boolean(profileData.is_superadmin),
            is_matrix_admin: Boolean(profileData.is_matrix_admin),
          });
        }
        setProfileLoading(false);
      });

    return () => {
      active = false;
    };
  }, [session, supabase]);

  useEffect(() => {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") {
      setThemeMode(stored);
    }
  }, []);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      const resolved = themeMode === "system" ? (mediaQuery.matches ? "dark" : "light") : themeMode;
      document.documentElement.setAttribute("data-theme", resolved);
    };

    applyTheme();
    localStorage.setItem(THEME_STORAGE_KEY, themeMode);

    const listener = () => {
      if (themeMode === "system") {
        applyTheme();
      }
    };

    mediaQuery.addEventListener("change", listener);
    return () => mediaQuery.removeEventListener("change", listener);
  }, [themeMode]);

  useEffect(() => {
    if (!supabase || !session || !userIsAdmin) {
      setFlavors([]);
      setSelectedFlavorId(null);
      setDataError(null);
      setDataLoading(false);
      return;
    }

    let active = true;
    setDataLoading(true);
    setDataError(null);

    void fetchFlavorsWithSteps(supabase, session.user.id)
      .then((nextFlavors) => {
        if (!active) {
          return;
        }
        setFlavors(nextFlavors);
        setSelectedFlavorId((current) => {
          if (!nextFlavors.length) {
            return null;
          }
          if (current && nextFlavors.some((flavor) => flavor.id === current)) {
            return current;
          }
          return nextFlavors[0].id;
        });
      })
      .catch((error: unknown) => {
        if (!active) {
          return;
        }
        setDataError(getErrorMessage(error, "Failed to load humor flavor data."));
      })
      .finally(() => {
        if (!active) {
          return;
        }
        setDataLoading(false);
      });

    return () => {
      active = false;
    };
  }, [dataRefreshToken, session, supabase, userIsAdmin]);

  useEffect(() => {
    if (!selectedFlavor) {
      setFlavorDraftName("");
      setFlavorDraftDescription("");
      setStepDrafts({});
      return;
    }

    setFlavorDraftName(selectedFlavor.name);
    setFlavorDraftDescription(selectedFlavor.description ?? "");

    const drafts: Record<string, StepDraft> = {};
    for (const step of selectedFlavor.steps) {
      drafts[step.id] = { title: step.title, prompt: step.prompt };
    }
    setStepDrafts(drafts);
  }, [selectedFlavor]);

  useEffect(() => {
    if (!supabase || !session || !userIsAdmin || !selectedFlavorId) {
      setCaptionRuns([]);
      setRunsError(null);
      setRunsLoading(false);
      return;
    }

    let active = true;
    setRunsLoading(true);
    setRunsError(null);

    void fetchCaptionRuns(supabase, selectedFlavorId)
      .then((runs) => {
        if (!active) {
          return;
        }
        const localRuns = readLocalCaptionRuns(session.user.id, selectedFlavorId);
        setCaptionRuns(mergeCaptionRuns(runs, localRuns));
      })
      .catch((error: unknown) => {
        if (!active) {
          return;
        }
        const localRuns = readLocalCaptionRuns(session.user.id, selectedFlavorId);
        setCaptionRuns(localRuns);
        setRunsError(getErrorMessage(error, "Failed to load caption history."));
      })
      .finally(() => {
        if (!active) {
          return;
        }
        setRunsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [runsRefreshToken, selectedFlavorId, session, supabase, userIsAdmin]);

  useEffect(() => {
    fileCacheRef.current = testFiles;
  }, [testFiles]);

  useEffect(() => {
    return () => {
      for (const entry of fileCacheRef.current) {
        URL.revokeObjectURL(entry.previewUrl);
      }
    };
  }, []);

  async function handleSignInWithGoogle() {
    if (!supabase) {
      return;
    }

    setIsSigningIn(true);
    setAuthError(null);

    try {
      const redirectTo = `${resolveAuthRedirectOrigin()}/auth/callback`;
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo,
        },
      });

      if (error) {
        setAuthError(error.message);
        setIsSigningIn(false);
      }
    } catch (error: unknown) {
      setAuthError(getErrorMessage(error, "Google sign-in failed."));
      setIsSigningIn(false);
    }
  }

  async function handleSignOut() {
    if (!supabase) {
      return;
    }
    await supabase.auth.signOut();
    setAuthError(null);
    setFlavors([]);
    setCaptionRuns([]);
    setSelectedFlavorId(null);
    setLatestCaptions([]);
    setLatestRawResponse(null);
    setPipelineStatus(null);
    setPipelineError(null);
    setPipelineWarning(null);
  }

  async function handleCreateFlavor(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !session) {
      return;
    }

    const name = newFlavorName.trim();
    if (!name) {
      setDataError("Humor flavor name is required.");
      return;
    }

    setIsCreatingFlavor(true);
    setDataError(null);

    const description = newFlavorDescription.trim() || null;
    const slug = toFlavorSlug(name);
    const insertCandidates: Array<Record<string, unknown>> = [
      {
        name,
        description,
        created_by: session.user.id,
      },
      {
        name,
        description,
        created_by_user_id: session.user.id,
        modified_by_user_id: session.user.id,
      },
      {
        slug,
        description,
        created_by_user_id: session.user.id,
        modified_by_user_id: session.user.id,
      },
      {
        slug,
        description,
        created_by: session.user.id,
      },
    ];

    let createdFlavorId: string | null = null;
    let createErrorMessage: string | null = null;

    for (const payload of insertCandidates) {
      const { data, error } = await supabase
        .from("humor_flavors")
        .insert(payload)
        .select("id")
        .single();

      if (error) {
        createErrorMessage = error.message;
        continue;
      }

      createdFlavorId =
        data && typeof data === "object" && "id" in data ? String(data.id as string | number) : null;
      break;
    }

    if (!createdFlavorId) {
      setDataError(createErrorMessage ?? "Failed to create flavor.");
      setIsCreatingFlavor(false);
      return;
    }

    setNewFlavorName("");
    setNewFlavorDescription("");
    setSelectedFlavorId(createdFlavorId);
    setDataRefreshToken((token) => token + 1);
    setIsCreatingFlavor(false);
  }

  async function handleSaveFlavor() {
    if (!supabase || !selectedFlavorId) {
      return;
    }

    const name = flavorDraftName.trim();
    if (!name) {
      setDataError("Humor flavor name is required.");
      return;
    }

    setIsSavingFlavor(true);
    setDataError(null);

    const description = flavorDraftDescription.trim() || null;
    const slug = toFlavorSlug(name);
    const updateCandidates: Array<Record<string, unknown>> = [
      {
        name,
        description,
      },
      {
        slug,
        description,
      },
    ];

    if (session?.user?.id) {
      updateCandidates.push({
        name,
        description,
        modified_by_user_id: session.user.id,
      });
      updateCandidates.push({
        slug,
        description,
        modified_by_user_id: session.user.id,
      });
    }

    let saveSucceeded = false;
    let saveErrorMessage: string | null = null;

    for (const payload of updateCandidates) {
      const response = await supabase
        .from("humor_flavors")
        .update(payload)
        .eq("id", selectedFlavorId);

      if (response.error) {
        saveErrorMessage = response.error.message;
        continue;
      }

      saveSucceeded = true;
      break;
    }

    if (!saveSucceeded) {
      setDataError(saveErrorMessage ?? "Failed to save flavor.");
    } else {
      setDataRefreshToken((token) => token + 1);
    }

    setIsSavingFlavor(false);
  }

  async function handleDeleteFlavor() {
    if (!supabase || !selectedFlavorId) {
      return;
    }

    const confirmed = window.confirm(
      "Delete this humor flavor and all of its steps? This cannot be undone.",
    );
    if (!confirmed) {
      return;
    }

    setIsDeletingFlavor(true);
    setDataError(null);

    const stepsDeleteResponse = await supabase
      .from("humor_flavor_steps")
      .delete()
      .eq("humor_flavor_id", selectedFlavorId);
    if (stepsDeleteResponse.error) {
      setDataError(stepsDeleteResponse.error.message);
      setIsDeletingFlavor(false);
      return;
    }

    const flavorDeleteResponse = await supabase.from("humor_flavors").delete().eq("id", selectedFlavorId);
    if (flavorDeleteResponse.error) {
      setDataError(flavorDeleteResponse.error.message);
      setIsDeletingFlavor(false);
      return;
    }

    if (session?.user?.id) {
      removeLocalCaptionRuns(session.user.id, [selectedFlavorId]);
    }

    setSelectedFlavorId(null);
    setDataRefreshToken((token) => token + 1);
    setRunsRefreshToken((token) => token + 1);
    setIsDeletingFlavor(false);
  }

  async function handleDeleteAllFlavors() {
    if (!supabase || !flavors.length) {
      return;
    }

    const confirmed = window.confirm(
      "Delete ALL humor flavors, steps, and caption runs? This cannot be undone.",
    );
    if (!confirmed) {
      return;
    }

    const typedConfirmation = window.prompt('Type DELETE to confirm:');
    if (typedConfirmation !== "DELETE") {
      return;
    }

    setIsDeletingAllFlavors(true);
    setDataError(null);

    const flavorIds = flavors.map((flavor) => flavor.id);
    const deleteErrorMessage = await deleteFlavorsByIds(supabase, flavorIds);
    if (deleteErrorMessage) {
      setDataError(deleteErrorMessage);
      setIsDeletingAllFlavors(false);
      return;
    }

    if (session?.user?.id) {
      removeLocalCaptionRuns(session.user.id, flavorIds);
    }

    setSelectedFlavorId(null);
    setCaptionRuns([]);
    setLatestCaptions([]);
    setLatestRawResponse(null);
    setPipelineStatus(null);
    setPipelineError(null);
    setPipelineWarning(null);
    setDataRefreshToken((token) => token + 1);
    setRunsRefreshToken((token) => token + 1);
    setIsDeletingAllFlavors(false);
  }

  async function handleCreateStep(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !session || !selectedFlavorId || !selectedFlavor) {
      return;
    }

    const title = newStepTitle.trim();
    const prompt = newStepPrompt.trim();
    if (!title || !prompt) {
      setDataError("Step title and prompt are required.");
      return;
    }

    setIsCreatingStep(true);
    setDataError(null);

    const maxOrder =
      selectedFlavor.steps.reduce((currentMax, step) => Math.max(currentMax, step.step_order), 0) + 1;

    const insertCandidates: Array<Record<string, unknown>> = [
      {
        humor_flavor_id: selectedFlavorId,
        title,
        prompt,
        step_order: maxOrder,
        created_by: session.user.id,
      },
      {
        humor_flavor_id: selectedFlavorId,
        title,
        prompt,
        step_order: maxOrder,
        created_by_user_id: session.user.id,
        modified_by_user_id: session.user.id,
      },
      {
        humor_flavor_id: selectedFlavorId,
        description: title,
        llm_user_prompt: prompt,
        llm_system_prompt: "You are a caption generator. Return only valid JSON.",
        llm_temperature: 0.7,
        order_by: maxOrder,
        llm_input_type_id: 1,
        llm_output_type_id: 2,
        llm_model_id: 1,
        humor_flavor_step_type_id: 1,
        created_by_user_id: session.user.id,
        modified_by_user_id: session.user.id,
      },
      {
        humor_flavor_id: selectedFlavorId,
        title,
        prompt,
        order_by: maxOrder,
        created_by_user_id: session.user.id,
        modified_by_user_id: session.user.id,
      },
      {
        humor_flavor_id: selectedFlavorId,
        title,
        prompt,
        order_by: maxOrder,
        created_by: session.user.id,
      },
    ];

    let createStepErrorMessage: string | null = null;
    let createStepSucceeded = false;

    for (const payload of insertCandidates) {
      const response = await supabase.from("humor_flavor_steps").insert(payload);
      if (response.error) {
        createStepErrorMessage = response.error.message;
        continue;
      }
      createStepSucceeded = true;
      break;
    }

    if (!createStepSucceeded) {
      setDataError(createStepErrorMessage ?? "Failed to create step.");
    } else {
      setNewStepTitle("");
      setNewStepPrompt("");
      setDataRefreshToken((token) => token + 1);
    }

    setIsCreatingStep(false);
  }

  function handleUseSuggestedNextStep() {
    const suggestion =
      STEP_TEMPLATE_SUGGESTIONS[Math.min(selectedSteps.length, STEP_TEMPLATE_SUGGESTIONS.length - 1)] ??
      STEP_TEMPLATE_SUGGESTIONS[0];
    if (!suggestion) {
      return;
    }

    setNewStepTitle(suggestion.title);
    setNewStepPrompt(suggestion.prompt);
  }

  function updateStepDraft(stepId: string, draft: Partial<StepDraft>) {
    setStepDrafts((current) => ({
      ...current,
      [stepId]: {
        title: draft.title ?? current[stepId]?.title ?? "",
        prompt: draft.prompt ?? current[stepId]?.prompt ?? "",
      },
    }));
  }

  async function handleSaveStep(stepId: string) {
    if (!supabase) {
      return;
    }

    const draft = stepDrafts[stepId];
    if (!draft) {
      return;
    }

    const title = draft.title.trim();
    const prompt = draft.prompt.trim();
    if (!title || !prompt) {
      setDataError("Step title and prompt are required.");
      return;
    }

    setStepSavingState((current) => ({ ...current, [stepId]: true }));
    setDataError(null);

    const updateCandidates: Array<Record<string, unknown>> = [
      { title, prompt },
      { description: title, llm_user_prompt: prompt },
    ];

    if (session?.user?.id) {
      updateCandidates.push({
        title,
        prompt,
        modified_by_user_id: session.user.id,
      });
      updateCandidates.push({
        description: title,
        llm_user_prompt: prompt,
        modified_by_user_id: session.user.id,
      });
    }

    let saveStepSucceeded = false;
    let saveStepErrorMessage: string | null = null;

    for (const payload of updateCandidates) {
      const response = await supabase
        .from("humor_flavor_steps")
        .update(payload)
        .eq("id", stepId);

      if (response.error) {
        saveStepErrorMessage = response.error.message;
        continue;
      }

      saveStepSucceeded = true;
      break;
    }

    if (!saveStepSucceeded) {
      setDataError(saveStepErrorMessage ?? "Failed to save step.");
    } else {
      setDataRefreshToken((token) => token + 1);
    }

    setStepSavingState((current) => ({ ...current, [stepId]: false }));
  }

  async function handleDeleteStep(stepId: string) {
    if (!supabase || !selectedFlavorId) {
      return;
    }

    const confirmed = window.confirm("Delete this step?");
    if (!confirmed) {
      return;
    }

    setStepSavingState((current) => ({ ...current, [stepId]: true }));
    setDataError(null);

    const deleteResponse = await supabase.from("humor_flavor_steps").delete().eq("id", stepId);
    if (deleteResponse.error) {
      setDataError(deleteResponse.error.message);
      setStepSavingState((current) => ({ ...current, [stepId]: false }));
      return;
    }

    let reorderTargets: Array<{ id: string; step_order: number }> = [];
    try {
      reorderTargets = await fetchOrderedStepRows(supabase, selectedFlavorId);
    } catch (error: unknown) {
      setDataError(getErrorMessage(error, "Failed to reorder steps."));
      setStepSavingState((current) => ({ ...current, [stepId]: false }));
      return;
    }

    const updateResponses = await Promise.all(
      reorderTargets.map((step, index) => persistStepOrder(supabase, step.id, index + 1)),
    );

    const firstError = updateResponses.find((error) => Boolean(error));
    if (firstError) {
      setDataError(firstError.message);
    } else {
      setDataRefreshToken((token) => token + 1);
    }

    setStepSavingState((current) => ({ ...current, [stepId]: false }));
  }

  async function handleReorderStep(stepId: string, direction: -1 | 1) {
    if (!supabase || !selectedFlavor) {
      return;
    }

    const ordered = [...selectedFlavor.steps].sort((a, b) => a.step_order - b.step_order);
    const currentIndex = ordered.findIndex((step) => step.id === stepId);
    const targetIndex = currentIndex + direction;
    if (currentIndex === -1 || targetIndex < 0 || targetIndex >= ordered.length) {
      return;
    }

    const reordered = [...ordered];
    const [movedStep] = reordered.splice(currentIndex, 1);
    if (!movedStep) {
      return;
    }
    reordered.splice(targetIndex, 0, movedStep);

    setIsReorderingStep(true);
    setDataError(null);

    const updates = await Promise.all(
      reordered.map((step, index) => persistStepOrder(supabase, step.id, index + 1)),
    );

    const firstError = updates.find((error) => Boolean(error));
    if (firstError) {
      setDataError(firstError.message);
    } else {
      setDataRefreshToken((token) => token + 1);
    }

    setIsReorderingStep(false);
  }

  function handleAddTestFiles(event: ChangeEvent<HTMLInputElement>) {
    const incoming = Array.from(event.target.files ?? []);
    if (!incoming.length) {
      return;
    }

    setPipelineError(null);

    const validFiles = incoming.filter((file) => SUPPORTED_IMAGE_TYPES.has(file.type.toLowerCase()));
    if (!validFiles.length) {
      setPipelineError("No supported image files were selected.");
      event.target.value = "";
      return;
    }

    const nextFiles = [...testFiles];
    let firstAddedId: string | null = null;

    for (const file of validFiles) {
      const duplicate = nextFiles.some(
        (existing) =>
          existing.file.name === file.name &&
          existing.file.size === file.size &&
          existing.file.lastModified === file.lastModified,
      );
      if (!duplicate) {
        const nextId = createId();
        if (!firstAddedId) {
          firstAddedId = nextId;
        }
        nextFiles.push({ id: nextId, file, previewUrl: URL.createObjectURL(file) });
      }
    }

    setTestFiles(nextFiles);
    if (!selectedTestFileId) {
      setSelectedTestFileId(firstAddedId ?? nextFiles[0]?.id ?? null);
    }
    event.target.value = "";
  }

  useEffect(() => {
    if (!testFiles.length) {
      setSelectedTestFileId(null);
      return;
    }

    if (selectedTestFileId && testFiles.some((entry) => entry.id === selectedTestFileId)) {
      return;
    }

    setSelectedTestFileId(testFiles[0].id);
  }, [selectedTestFileId, testFiles]);

  function removeTestFile(fileId: string) {
    setTestFiles((current) => {
      const match = current.find((entry) => entry.id === fileId);
      if (match) {
        URL.revokeObjectURL(match.previewUrl);
      }
      return current.filter((entry) => entry.id !== fileId);
    });
  }

  async function postPipelineRequest(path: string, token: string, body: unknown) {
    const response = await fetch(`${ALMOSTCRACKD_API_BASE_URL}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const payload = await safeJson(response);
    if (!response.ok) {
      const message = extractApiError(payload) ?? `Request failed with status ${response.status}`;
      throw new Error(message);
    }

    return payload;
  }

  async function handleGenerateCaptions() {
    if (!supabase || !session || !selectedFlavor || !selectedTestFile) {
      return;
    }

    setPipelineError(null);
    setPipelineWarning(null);
    setPipelineStatus("Step 1/4: Generating presigned upload URL...");
    setIsGeneratingCaptions(true);

    try {
      const contentType = selectedTestFile.file.type || "image/jpeg";
      const presignPayload = (await postPipelineRequest(
        "/pipeline/generate-presigned-url",
        session.access_token,
        {
          contentType,
        },
      )) as Record<string, unknown>;

      const presignedUrl = typeof presignPayload.presignedUrl === "string" ? presignPayload.presignedUrl : null;
      const cdnUrl = typeof presignPayload.cdnUrl === "string" ? presignPayload.cdnUrl : null;
      if (!presignedUrl || !cdnUrl) {
        throw new Error("Presigned URL response is missing presignedUrl/cdnUrl.");
      }

      setPipelineStatus("Step 2/4: Uploading image bytes to presigned URL...");
      const uploadResponse = await fetch(presignedUrl, {
        method: "PUT",
        headers: { "Content-Type": contentType },
        body: selectedTestFile.file,
      });

      if (!uploadResponse.ok) {
        throw new Error(`Image upload failed with status ${uploadResponse.status}.`);
      }

      setPipelineStatus("Step 3/4: Registering uploaded image URL...");
      const registerPayload = (await postPipelineRequest(
        "/pipeline/upload-image-from-url",
        session.access_token,
        { imageUrl: cdnUrl, isCommonUse: false },
      )) as Record<string, unknown>;
      const imageId = typeof registerPayload.imageId === "string" ? registerPayload.imageId : null;
      if (!imageId) {
        throw new Error("Image registration response is missing imageId.");
      }

      setPipelineStatus("Step 4/4: Generating captions...");
      const captionPayload = await postPipelineRequest("/pipeline/generate-captions", session.access_token, {
        imageId,
        humorFlavorId: selectedFlavor.id,
      });

      const captions = extractCaptions(captionPayload);
      setLatestCaptions(captions);
      setLatestRawResponse(captionPayload);
      setPipelineStatus("Caption generation finished.");

      const captionRunCandidates: Array<Record<string, unknown>> = [
        {
          humor_flavor_id: selectedFlavor.id,
          image_name: selectedTestFile.file.name,
          image_id: imageId,
          captions,
          raw_response: captionPayload,
          created_by: session.user.id,
        },
        {
          humor_flavor_id: selectedFlavor.id,
          image_name: selectedTestFile.file.name,
          image_id: imageId,
          captions,
          raw_response: captionPayload,
          created_by_user_id: session.user.id,
          modified_by_user_id: session.user.id,
        },
        {
          humor_flavor_id: selectedFlavor.id,
          image_name: selectedTestFile.file.name,
          image_id: imageId,
          captions,
          raw_response: captionPayload,
        },
      ];

      let persistenceErrorMessage: string | null = null;
      let persistenceSucceeded = false;
      let historyTableMissing = false;

      for (const payload of captionRunCandidates) {
        const persistenceResponse = await supabase.from("humor_flavor_caption_runs").insert(payload);
        if (persistenceResponse.error) {
          persistenceErrorMessage = persistenceResponse.error.message;
          if (isMissingTableError(persistenceResponse.error)) {
            historyTableMissing = true;
            break;
          }
          continue;
        }
        persistenceSucceeded = true;
        break;
      }

      if (!persistenceSucceeded) {
        const localRun: CaptionRun = {
          id: `local-${createId()}`,
          humor_flavor_id: selectedFlavor.id,
          image_name: selectedTestFile.file.name,
          image_id: imageId,
          captions,
          raw_response: captionPayload,
          created_at: new Date().toISOString(),
        };
        saveLocalCaptionRun(session.user.id, localRun);
        setRunsRefreshToken((token) => token + 1);

        if (historyTableMissing) {
          setPipelineWarning(
            "Captions generated successfully. DB history table is missing, so this run was saved to local history in this browser.",
          );
        } else {
          setPipelineWarning(
            `Captions were generated. DB save failed, so this run was saved locally in this browser: ${
              persistenceErrorMessage ?? "Unknown error."
            }`,
          );
        }
      } else {
        setRunsRefreshToken((token) => token + 1);
      }
    } catch (error: unknown) {
      setPipelineError(getErrorMessage(error, "Caption generation failed."));
      setPipelineStatus(null);
    } finally {
      setIsGeneratingCaptions(false);
    }
  }

  if (envError) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-5xl items-center justify-center p-6">
        <div className="surface-card w-full max-w-xl p-6">
          <h1 className="text-2xl font-semibold">Configuration Error</h1>
          <p className="mt-2 text-sm text-[var(--muted)]">{envError}</p>
          <p className="mt-2 text-sm text-[var(--muted)]">
            Set <code>NEXT_PUBLIC_SUPABASE_URL</code> and either <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code> or{" "}
            <code>NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY</code> in your environment.
          </p>
        </div>
      </main>
    );
  }

  if (authLoading || profileLoading) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-5xl items-center justify-center p-6">
        <p className="text-sm text-[var(--muted)]">Loading session...</p>
      </main>
    );
  }

  if (!session) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-5xl items-center justify-center p-6">
        <div className="surface-card w-full max-w-md p-6">
          <h1 className="text-2xl font-semibold">Humor Flavor Tool</h1>
          <p className="mt-2 text-sm text-[var(--muted)]">
            Continue with your Google account. Access is restricted to admins.
          </p>
          <p className="mt-2 text-sm text-[var(--muted)]">
            Google provider must be enabled in your Supabase Auth settings.
          </p>
          {authError ? <p className="status-error mt-4">{authError}</p> : null}
          <button
            className="primary-btn mt-6 w-full"
            type="button"
            onClick={handleSignInWithGoogle}
            disabled={isSigningIn}
          >
            {isSigningIn ? "Redirecting to Google..." : "Continue with Google"}
          </button>
        </div>
      </main>
    );
  }

  if (profileError) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-5xl items-center justify-center p-6">
        <div className="surface-card w-full max-w-xl p-6">
          <h1 className="text-2xl font-semibold">Profile Error</h1>
          <p className="mt-2 text-sm text-[var(--muted)]">{profileError}</p>
          <button className="secondary-btn mt-4" type="button" onClick={handleSignOut}>
            Sign out
          </button>
        </div>
      </main>
    );
  }

  if (!userIsAdmin) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-5xl items-center justify-center p-6">
        <div className="surface-card w-full max-w-xl p-6">
          <h1 className="text-2xl font-semibold">Admin Access Required</h1>
          <p className="mt-2 text-sm text-[var(--muted)]">
            This tool only works for profiles where <code>is_superadmin</code> or <code>is_matrix_admin</code> is
            true.
          </p>
          <p className="mt-2 text-sm text-[var(--muted)]">Signed in as {profile?.email ?? session.user.email}.</p>
          <button className="secondary-btn mt-4" type="button" onClick={handleSignOut}>
            Sign out
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto min-h-screen w-full max-w-7xl p-5 md:p-8">
      <header className="mb-6 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Humor Flavor Prompt Chain Tool</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Manage your humor flavors, define ordered steps, and test caption generation with the staging API.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="field-label text-xs">
            Theme
            <select
              className="field-input mt-1"
              value={themeMode}
              onChange={(event) => setThemeMode(event.target.value as ThemeMode)}
            >
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
          <button className="secondary-btn" type="button" onClick={handleSignOut}>
            Sign out
          </button>
        </div>
      </header>

      <section className="grid gap-5 lg:grid-cols-[320px_1fr]">
        <aside className="surface-card p-4">
          <h2 className="text-lg font-semibold">Humor Flavors</h2>
          <form className="mt-4 space-y-3" onSubmit={handleCreateFlavor}>
            <label className="field-label">
              Name
              <input
                className="field-input mt-1"
                type="text"
                value={newFlavorName}
                onChange={(event) => setNewFlavorName(event.target.value)}
                placeholder="Flavor name"
                required
              />
            </label>
            <label className="field-label">
              Description
              <textarea
                className="field-input mt-1 min-h-20"
                value={newFlavorDescription}
                onChange={(event) => setNewFlavorDescription(event.target.value)}
                placeholder="What kind of humor does this flavor generate?"
              />
            </label>
            <button className="primary-btn w-full" type="submit" disabled={isCreatingFlavor}>
              {isCreatingFlavor ? "Creating..." : "Create Flavor"}
            </button>
          </form>
          <button
            className="danger-btn mt-3 w-full"
            type="button"
            onClick={handleDeleteAllFlavors}
            disabled={isDeletingAllFlavors || !flavors.length}
          >
            {isDeletingAllFlavors ? "Deleting all..." : "Delete All Flavors"}
          </button>

          <div className="mt-5 space-y-2">
            {dataLoading && !flavors.length ? <p className="text-sm text-[var(--muted)]">Loading flavors...</p> : null}
            {!dataLoading && !flavors.length ? (
              <p className="text-sm text-[var(--muted)]">No humor flavors yet.</p>
            ) : null}
            {flavors.map((flavor) => (
              <button
                key={flavor.id}
                type="button"
                onClick={() => setSelectedFlavorId(flavor.id)}
                className={`w-full rounded-xl border px-3 py-3 text-left transition ${
                  selectedFlavorId === flavor.id
                    ? "border-[var(--accent)] bg-[var(--accent-soft)]"
                    : "border-[var(--border)] bg-[var(--surface-muted)] hover:border-[var(--accent)]/60"
                }`}
              >
                <p className="font-medium">{flavor.name}</p>
                <p className="text-xs text-[var(--muted)]">{flavor.steps.length} step(s)</p>
              </button>
            ))}
          </div>
        </aside>

        <div className="space-y-5">
          {dataError ? <p className="status-error">{dataError}</p> : null}

          {!selectedFlavor ? (
            <section className="surface-card p-6">
              <p className="text-sm text-[var(--muted)]">
                Select a humor flavor from the left panel, or create one to get started.
              </p>
            </section>
          ) : (
            <>
              <section className="surface-card p-5">
                <div className="mb-4 flex items-center justify-between gap-2">
                  <h2 className="text-xl font-semibold">Flavor Details</h2>
                  <button
                    className="danger-btn"
                    type="button"
                    onClick={handleDeleteFlavor}
                    disabled={isDeletingFlavor}
                  >
                    {isDeletingFlavor ? "Deleting..." : "Delete Flavor"}
                  </button>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="field-label">
                    Flavor Name
                    <input
                      className="field-input mt-1"
                      type="text"
                      value={flavorDraftName}
                      onChange={(event) => setFlavorDraftName(event.target.value)}
                    />
                  </label>
                  <label className="field-label md:col-span-2">
                    Description
                    <textarea
                      className="field-input mt-1 min-h-20"
                      value={flavorDraftDescription}
                      onChange={(event) => setFlavorDraftDescription(event.target.value)}
                    />
                  </label>
                </div>
                <button
                  className="primary-btn mt-4"
                  type="button"
                  onClick={handleSaveFlavor}
                  disabled={isSavingFlavor}
                >
                  {isSavingFlavor ? "Saving..." : "Save Flavor"}
                </button>
              </section>

              <section className="surface-card p-5">
                <h2 className="text-xl font-semibold">Flavor Steps</h2>
                <p className="mt-1 text-sm text-[var(--muted)]">
                  Steps run in ascending order and form your prompt chain.
                </p>
                <div className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] p-3">
                  <p className="text-sm font-medium">Suggested 3-step template</p>
                  <p className="mt-1 text-xs text-[var(--muted)]">
                    1) Describe image literally 2) Find funny angle 3) Generate 5 short captions.
                  </p>
                  <button className="secondary-btn mt-3 px-3 py-1 text-xs" type="button" onClick={handleUseSuggestedNextStep}>
                    Use Suggested Next Step
                  </button>
                </div>

                <form className="mt-4 grid gap-3 md:grid-cols-2" onSubmit={handleCreateStep}>
                  <label className="field-label">
                    Step Title
                    <input
                      className="field-input mt-1"
                      type="text"
                      value={newStepTitle}
                      onChange={(event) => setNewStepTitle(event.target.value)}
                      placeholder="Example: Describe image"
                      required
                    />
                  </label>
                  <label className="field-label md:col-span-2">
                    Step Prompt
                    <textarea
                      className="field-input mt-1 min-h-24"
                      value={newStepPrompt}
                      onChange={(event) => setNewStepPrompt(event.target.value)}
                      placeholder="Instruction for this step..."
                      required
                    />
                  </label>
                  <button className="primary-btn md:w-fit" type="submit" disabled={isCreatingStep}>
                    {isCreatingStep ? "Adding..." : "Add Step"}
                  </button>
                </form>

                <div className="mt-5 space-y-3">
                  {!selectedSteps.length ? (
                    <p className="text-sm text-[var(--muted)]">No steps yet for this flavor.</p>
                  ) : null}
                  {selectedSteps.map((step, index) => {
                    const draft = stepDrafts[step.id] ?? { title: step.title, prompt: step.prompt };
                    const isSaving = Boolean(stepSavingState[step.id]) || isReorderingStep;

                    return (
                      <article key={step.id} className="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-4">
                        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                          <p className="text-sm font-semibold">Step {index + 1}</p>
                          <div className="flex items-center gap-2">
                            <button
                              className="secondary-btn px-3 py-1 text-xs"
                              type="button"
                              onClick={() => handleReorderStep(step.id, -1)}
                              disabled={isSaving || index === 0}
                            >
                              Move Up
                            </button>
                            <button
                              className="secondary-btn px-3 py-1 text-xs"
                              type="button"
                              onClick={() => handleReorderStep(step.id, 1)}
                              disabled={isSaving || index === selectedSteps.length - 1}
                            >
                              Move Down
                            </button>
                          </div>
                        </div>

                        <label className="field-label">
                          Title
                          <input
                            className="field-input mt-1"
                            type="text"
                            value={draft.title}
                            onChange={(event) => updateStepDraft(step.id, { title: event.target.value })}
                          />
                        </label>
                        <label className="field-label mt-3">
                          Prompt
                          <textarea
                            className="field-input mt-1 min-h-20"
                            value={draft.prompt}
                            onChange={(event) => updateStepDraft(step.id, { prompt: event.target.value })}
                          />
                        </label>

                        <div className="mt-3 flex flex-wrap gap-2">
                          <button
                            className="primary-btn"
                            type="button"
                            onClick={() => handleSaveStep(step.id)}
                            disabled={isSaving}
                          >
                            {isSaving ? "Saving..." : "Save Step"}
                          </button>
                          <button
                            className="danger-btn"
                            type="button"
                            onClick={() => handleDeleteStep(step.id)}
                            disabled={isSaving}
                          >
                            Delete Step
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>

              <section className="surface-card p-5">
                <h2 className="text-xl font-semibold">Test Flavor with API Pipeline</h2>
                <p className="mt-1 text-sm text-[var(--muted)]">
                  Upload image files to your test set, then run the 4-step API pipeline using this flavor.
                </p>

                <label className="field-label mt-4">
                  Add test images
                  <input
                    className="field-input mt-1"
                    type="file"
                    accept="image/jpeg,image/jpg,image/png,image/webp,image/gif,image/heic"
                    multiple
                    onChange={handleAddTestFiles}
                  />
                </label>

                <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {testFiles.map((entry) => (
                    <article key={entry.id} className="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-3">
                      <Image
                        src={entry.previewUrl}
                        alt={entry.file.name}
                        width={640}
                        height={400}
                        unoptimized
                        className="h-32 w-full rounded-md object-cover"
                      />
                      <p className="mt-2 truncate text-xs text-[var(--muted)]">{entry.file.name}</p>
                      <div className="mt-2 flex gap-2">
                        <button
                          className="secondary-btn px-3 py-1 text-xs"
                          type="button"
                          onClick={() => setSelectedTestFileId(entry.id)}
                        >
                          {selectedTestFileId === entry.id ? "Selected" : "Use"}
                        </button>
                        <button
                          className="danger-btn px-3 py-1 text-xs"
                          type="button"
                          onClick={() => removeTestFile(entry.id)}
                        >
                          Remove
                        </button>
                      </div>
                    </article>
                  ))}
                </div>

                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <button
                    className="primary-btn"
                    type="button"
                    onClick={handleGenerateCaptions}
                    disabled={!selectedTestFile || isGeneratingCaptions}
                  >
                    {isGeneratingCaptions ? "Generating..." : "Generate Captions"}
                  </button>
                  <p className="text-xs text-[var(--muted)]">
                    {selectedTestFile ? `Selected image: ${selectedTestFile.file.name}` : "Select an image from the test set."}
                  </p>
                </div>

                {pipelineStatus ? <p className="status-info mt-3">{pipelineStatus}</p> : null}
                {pipelineWarning ? <p className="status-warn mt-2">{pipelineWarning}</p> : null}
                {pipelineError ? <p className="status-error mt-2">{pipelineError}</p> : null}

                {latestCaptions.length > 0 ? (
                  <div className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-4">
                    <h3 className="font-semibold">Latest Captions</h3>
                    <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
                      {latestCaptions.map((caption, index) => (
                        <li key={`${caption}-${index}`}>{caption}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {latestRawResponse ? (
                  <details className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-4">
                    <summary className="cursor-pointer font-semibold">Latest Raw API Response</summary>
                    <pre className="mt-2 overflow-auto text-xs text-[var(--muted)]">
                      {JSON.stringify(latestRawResponse, null, 2)}
                    </pre>
                  </details>
                ) : null}
              </section>

              <section className="surface-card p-5">
                <h2 className="text-xl font-semibold">Caption History for This Flavor</h2>
                <p className="mt-1 text-xs text-[var(--muted)]">
                  History shows database runs and local fallback runs saved in this browser.
                </p>
                {runsLoading ? <p className="mt-2 text-sm text-[var(--muted)]">Loading caption history...</p> : null}
                {runsError ? <p className="status-error mt-2">{runsError}</p> : null}
                {!runsLoading && !runsError && !captionRuns.length ? (
                  <p className="mt-2 text-sm text-[var(--muted)]">No caption runs saved yet for this flavor.</p>
                ) : null}
                <div className="mt-3 space-y-3">
                  {captionRuns.map((run) => (
                    <article key={run.id} className="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-4">
                      <p className="text-xs text-[var(--muted)]">
                        {new Date(run.created_at).toLocaleString()} • {run.image_name}
                      </p>
                      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
                        {run.captions.length ? (
                          run.captions.map((caption, index) => <li key={`${run.id}-${index}`}>{caption}</li>)
                        ) : (
                          <li>No parsed captions found in saved run.</li>
                        )}
                      </ul>
                    </article>
                  ))}
                </div>
              </section>
            </>
          )}
        </div>
      </section>
    </main>
  );
}
