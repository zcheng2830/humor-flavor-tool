# Humor Flavor Tool

Admin-only prompt-chain manager for creating and testing humor flavors against the AlmostCrackd staging pipeline API.

## Features

- Admin gate: app works only when `profiles.is_superadmin = true` or `profiles.is_matrix_admin = true`
- Humor flavor CRUD:
  - Create, update, delete flavors
- Humor flavor step CRUD:
  - Create, update, delete steps
  - Reorder steps (move up / move down)
- Caption testing:
  - Build an image test set from uploaded files
  - Call the required 4-step API flow:
    1. `POST /pipeline/generate-presigned-url`
    2. `PUT` image bytes to presigned URL
    3. `POST /pipeline/upload-image-from-url`
    4. `POST /pipeline/generate-captions` (with `humorFlavorId`)
- Caption history:
  - Save generated captions per flavor
  - Read caption runs for selected flavor
- Theme modes:
  - Light / Dark / System

## Tech Stack

- Next.js 16 (App Router)
- React 19
- Supabase JS client

## Local Setup

1. Install deps:

```bash
npm install
```

2. Create `.env.local` from `.env.example` and fill values:

```bash
cp .env.example .env.local
```

Required env vars:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `NEXT_PUBLIC_ALMOSTCRACKD_API_BASE_URL` (default `https://api.almostcrackd.ai`)

3. Run SQL in Supabase:

- Execute [`supabase/schema.sql`](./supabase/schema.sql) in your Supabase SQL editor.
- This creates `humor_flavors`, `humor_flavor_steps`, `humor_flavor_caption_runs`, plus admin-only RLS policies.

4. Start dev server:

```bash
npm run dev
```

## Deployment Checklist

1. Create a new GitHub repo and push this project.
2. Create a new Vercel project from that repo.
3. Add the same env vars in Vercel project settings.
4. Deploy.

## Notes

- The app uses the logged-in Supabase session JWT as the `Authorization: Bearer <token>` header for `api.almostcrackd.ai`.
- Supported test image file types:
  - `image/jpeg`, `image/jpg`, `image/png`, `image/webp`, `image/gif`, `image/heic`
