import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

// Standard shadcn/ui helper: tailwind-merge over clsx.
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
