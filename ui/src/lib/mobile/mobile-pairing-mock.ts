/**
 * NEXORA Mobile Pairing and Control Plane Mock API Adapter
 * Exposes pairing verification and global emergency stops.
 */

export interface PairingCodeInfo {
  pairingCode: string;
  expiresAt: string;
  qrUrl: string;
}

export interface PairedDevice {
  deviceId: string;
  deviceName: string;
  pairedAt: string;
  lastActiveAt: string;
}

export const mockMobilePairingApi = {
  getPairingCode: async (companyId: string): Promise<PairingCodeInfo> => {
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve({
          pairingCode: "NEX-824",
          expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
          qrUrl: `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=nexora-pairing:NEX-824`
        });
      }, 500);
    });
  },

  confirmPairing: async (code: string, deviceName: string): Promise<{ success: boolean; deviceToken: string }> => {
    return new Promise((resolve) => {
      setTimeout(() => {
        if (code === "NEX-824") {
          resolve({ success: true, deviceToken: `token_${Math.random().toString(36).substring(2, 10)}` });
        } else {
          resolve({ success: false, deviceToken: "" });
        }
      }, 800);
    });
  },

  listDevices: async (companyId: string): Promise<PairedDevice[]> => {
    return new Promise((resolve) => {
      resolve([
        {
          deviceId: "dev-iphone-15",
          deviceName: "서대곤 대표 iPhone 15 Pro",
          pairedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
          lastActiveAt: new Date().toISOString()
        },
        {
          deviceId: "dev-ipad-m2",
          deviceName: "대표실 iPad Air",
          pairedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
          lastActiveAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
        }
      ]);
    });
  },

  unpairDevice: async (deviceId: string): Promise<{ success: boolean }> => {
    return new Promise((resolve) => {
      setTimeout(() => resolve({ success: true }), 400);
    });
  }
};
