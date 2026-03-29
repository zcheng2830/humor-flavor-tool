import type { User } from "@supabase/supabase-js";

type UserLike = Pick<User, "app_metadata" | "identities">;

export function isGoogleUser(user: UserLike | null | undefined) {
  if (!user) {
    return false;
  }

  const appMetadata = (user.app_metadata ?? {}) as Record<string, unknown>;

  if (appMetadata.provider === "google") {
    return true;
  }

  if (
    Array.isArray(appMetadata.providers) &&
    appMetadata.providers.some((provider) => provider === "google")
  ) {
    return true;
  }

  if (
    Array.isArray(user.identities) &&
    user.identities.some((identity) => identity.provider === "google")
  ) {
    return true;
  }

  return false;
}
