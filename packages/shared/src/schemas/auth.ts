import { z } from "zod";
import { SELF_SIGNUP_ROLES } from "../roles";

export const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));

/** At least 10 chars, one letter and one digit. Length beats complexity rules. */
export const passwordSchema = z
  .string()
  .min(10, "Password must be at least 10 characters")
  .max(128, "Password must be at most 128 characters")
  .refine((v) => /[A-Za-z]/.test(v) && /\d/.test(v), "Password must contain a letter and a digit");

export const signupSchema = z.object({
  fullName: z.string().trim().min(1, "Name is required").max(200),
  email: emailSchema,
  password: passwordSchema,
  accountType: z.enum(SELF_SIGNUP_ROLES).default("CUSTOMER"),
});
export type SignupInput = z.infer<typeof signupSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
  client: z.enum(["web", "extension"]).default("web"),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const otpSchema = z.string().regex(/^\d{6}$/, "Enter the 6-digit code");

export const verifyEmailSchema = z.object({ code: otpSchema });

export const forgotPasswordSchema = z.object({ email: emailSchema });

export const resetPasswordSchema = z.object({
  token: z.string().min(20).max(200),
  password: passwordSchema,
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: passwordSchema,
});
