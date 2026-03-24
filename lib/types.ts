export type ThemeMode = "system" | "light" | "dark";

export interface Profile {
  id: string;
  email?: string | null;
  is_superadmin: boolean;
  is_matrix_admin: boolean;
}

export interface HumorFlavor {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface HumorFlavorStep {
  id: string;
  humor_flavor_id: string;
  title: string;
  prompt: string;
  step_order: number;
  created_at: string;
  updated_at: string;
}

export interface CaptionRun {
  id: string;
  humor_flavor_id: string;
  image_name: string;
  image_id: string;
  captions: string[];
  raw_response: unknown;
  created_at: string;
}

export interface FlavorWithSteps extends HumorFlavor {
  steps: HumorFlavorStep[];
}
