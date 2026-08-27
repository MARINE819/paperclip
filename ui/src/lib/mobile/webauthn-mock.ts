/**
 * NEXORA Mobile WebAuthn Mock Authentication Adapter
 * Under Task B-5 & Phase C-1 Governance: Biometric gates are simulated
 * with explicit user action to prevent automated spoofing of credential success.
 */

export interface BiometricAuthResult {
  success: boolean;
  credentialId?: string;
  signature?: string;
  error?: string;
}

export const webauthnMock = {
  /**
   * Triggers a simulated biometric prompt (Face ID / Touch ID / PIN)
   * It takes a short delay to mimic native OS authentication.
   */
  authenticate: async (challengePayload: string): Promise<BiometricAuthResult> => {
    return new Promise((resolve) => {
      // Simulate typical 1.2 second biometric scan delay
      setTimeout(() => {
        // We do not silently auto-succeed without input. In mock mode, we look for a local window consent
        // or prompt. To ensure it is a safe test, we read confirmation.
        const consent = window.confirm(
          `[NEXORA Biometric Gate]\n\n보안 챌린지 검증:\n${challengePayload}\n\nFace ID / 기기 생체 인증을 수행하시겠습니까?`
        );

        if (consent) {
          resolve({
            success: true,
            credentialId: `cred_${Math.random().toString(36).substring(2, 15)}`,
            signature: `sig_${Math.random().toString(36).substring(2, 15)}`
          });
        } else {
          resolve({
            success: false,
            error: "Biometric authentication cancelled by user"
          });
        }
      }, 1200);
    });
  }
};
