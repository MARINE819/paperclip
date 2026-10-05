import type {
  PublicKeyCredentialCreationOptionsJSON,
  RegistrationResponseJSON,
  PublicKeyCredentialRequestOptionsJSON,
  AuthenticationResponseJSON,
} from "@simplewebauthn/browser";
import { api } from "./client";

export interface WebAuthnCredentialSummary {
  id: string;
  credentialId: string;
  deviceName: string | null;
  counter: number;
  transports: string[] | null;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface WebAuthnVerifyRegistrationResult {
  verified: boolean;
  credentialId: string;
  userId: string;
  companyId: string;
  deviceName?: string;
}

export interface WebAuthnVerifyAuthenticationResult {
  verified: boolean;
  credentialId: string;
  userId: string;
  companyId: string;
  bindingId?: string;
  approvalToken?: string;
  resumeToken?: string;
}

export const webauthnApi = {
  getRegistrationOptions: (companyId: string) =>
    api.post<PublicKeyCredentialCreationOptionsJSON>(
      `/companies/${companyId}/webauthn/register/options`,
      {},
    ),

  verifyRegistration: (
    companyId: string,
    data: { response: RegistrationResponseJSON; deviceName?: string },
  ) =>
    api.post<WebAuthnVerifyRegistrationResult>(
      `/companies/${companyId}/webauthn/register/verify`,
      data,
    ),

  getAuthenticationOptions: (
    companyId: string,
    data: { purpose: "approval_decision" | "login" | "emergency_resume"; bindingId?: string },
  ) =>
    api.post<PublicKeyCredentialRequestOptionsJSON>(
      `/companies/${companyId}/webauthn/authenticate/options`,
      data,
    ),

  verifyAuthentication: (
    companyId: string,
    data: {
      purpose: "approval_decision" | "login" | "emergency_resume";
      bindingId?: string;
      response: AuthenticationResponseJSON;
    },
  ) =>
    api.post<WebAuthnVerifyAuthenticationResult>(
      `/companies/${companyId}/webauthn/authenticate/verify`,
      data,
    ),

  listCredentials: (companyId: string) =>
    api.get<WebAuthnCredentialSummary[]>(
      `/companies/${companyId}/webauthn/credentials`,
    ),

  deleteCredential: (companyId: string, credentialId: string) =>
    api.delete<{ deleted: boolean }>(
      `/companies/${companyId}/webauthn/credentials/${credentialId}`,
    ),
};
