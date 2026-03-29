import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import { getSupabaseCredentials } from "@/lib/supabase-client";

export async function createSupabaseServerClient() {
  const cookieStore = await cookies();
  const { url, publishableKey } = getSupabaseCredentials();

  return createServerClient(url, publishableKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // `setAll` can run in Server Components where cookie writes are not allowed.
        }
      },
    },
  });
}
