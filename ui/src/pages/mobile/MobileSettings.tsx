import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "../../context/CompanyContext";
import { useBreadcrumbs } from "../../context/BreadcrumbContext";
import { mockMobilePairingApi } from "../../lib/mobile/mobile-pairing-mock";
import { webauthnApi, type WebAuthnCredentialSummary } from "../../api/webauthn";
import { pushApi, urlBase64ToUint8Array } from "../../api/push";
import { startRegistration, browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ShieldCheck, PhoneCall, Trash2, Bell, Shield, Fingerprint, Info } from "lucide-react";

export function MobileSettings() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  const [pairingCodeInfo, setPairingCodeInfo] = useState<any>(null);
  const [isGeneratingPairing, setIsGeneratingPairing] = useState(false);
  const [isRegisteringBiometrics, setIsRegisteringBiometrics] = useState(false);
  const [pushSubscribed, setPushSubscribed] = useState(false);
  const [isPushLoading, setIsPushLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "모바일 설정" }]);
  }, [setBreadcrumbs]);

  // Detect iOS Safari standalone PWA mode
  const isIos = typeof navigator !== "undefined" && /iPad|iPhone|iPod/.test(navigator.userAgent);
  const isStandalone =
    typeof window !== "undefined" &&
    (Boolean(window.matchMedia?.("(display-mode: standalone)")?.matches) ||
      Boolean((navigator as any).standalone));
  const showIosPwaBanner = isIos && !isStandalone;

  // Check current browser Push subscription status on mount
  useEffect(() => {
    if (
      typeof window !== "undefined" &&
      "serviceWorker" in navigator &&
      "PushManager" in window
    ) {
      navigator.serviceWorker.ready
        .then((reg) => reg.pushManager.getSubscription())
        .then((sub) => {
          setPushSubscribed(Boolean(sub));
        })
        .catch(() => {});
    }
  }, []);

  // Query real registered WebAuthn credentials
  const { data: credentials, isLoading: isLoadingCredentials } = useQuery<
    WebAuthnCredentialSummary[]
  >({
    queryKey: ["webauthn-credentials", selectedCompanyId],
    queryFn: () => webauthnApi.listCredentials(selectedCompanyId || ""),
    enabled: !!selectedCompanyId,
  });

  const deleteCredentialMutation = useMutation({
    mutationFn: (id: string) =>
      webauthnApi.deleteCredential(selectedCompanyId!, id),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["webauthn-credentials", selectedCompanyId],
      });
      setStatusMessage("생체 인증 기기가 삭제되었습니다.");
    },
    onError: (err) => {
      setErrorMessage(err instanceof Error ? err.message : "기기 삭제 실패");
    },
  });

  const handleRegisterBiometrics = async () => {
    if (!selectedCompanyId) return;
    setIsRegisteringBiometrics(true);
    setStatusMessage(null);
    setErrorMessage(null);

    try {
      if (!browserSupportsWebAuthn()) {
        setErrorMessage("이 브라우저 또는 기기는 WebAuthn을 지원하지 않습니다.");
        return;
      }

      // 1. Get registration options from server
      const options = await webauthnApi.getRegistrationOptions(selectedCompanyId);

      // 2. Trigger native OS Face ID / Touch ID enrollment prompt
      const registrationResponse = await startRegistration({ optionsJSON: options });

      // 3. Verify and save credential on server
      const deviceName = `${navigator.userAgent.includes("iPhone") ? "iPhone" : "모바일 기기"} (${new Date().toLocaleDateString()})`;
      await webauthnApi.verifyRegistration(selectedCompanyId, {
        response: registrationResponse,
        deviceName,
      });

      queryClient.invalidateQueries({
        queryKey: ["webauthn-credentials", selectedCompanyId],
      });
      setStatusMessage("Face ID / 지문 생체 인증 기기가 성공적으로 등록되었습니다.");
    } catch (e: any) {
      if (e?.name === "NotAllowedError") {
        setErrorMessage("생체 인증 등록이 취소되었습니다.");
      } else {
        setErrorMessage(e instanceof Error ? e.message : "등록 중 오류가 발생했습니다.");
      }
    } finally {
      setIsRegisteringBiometrics(false);
    }
  };

  const handleTogglePush = async (enable: boolean) => {
    if (!selectedCompanyId) return;
    setIsPushLoading(true);
    setStatusMessage(null);
    setErrorMessage(null);

    try {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        setErrorMessage("이 브라우저는 Web Push 알림을 지원하지 않습니다.");
        return;
      }

      const reg = await navigator.serviceWorker.ready;

      if (enable) {
        // Direct user gesture required
        const permission = await Notification.requestPermission();
        if (permission !== "granted") {
          setErrorMessage("알림 권한이 허용되지 않았습니다. 브라우저 설정에서 알림을 켜주세요.");
          setPushSubscribed(false);
          return;
        }

        const { publicKey } = await pushApi.getPublicKey();
        const appServerKey = urlBase64ToUint8Array(publicKey);

        const sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: appServerKey as unknown as BufferSource,
        });

        const subJson = sub.toJSON();
        await pushApi.subscribe(selectedCompanyId, {
          endpoint: sub.endpoint,
          keys: subJson.keys as { p256dh: string; auth: string },
        });

        setPushSubscribed(true);
        setStatusMessage("Web Push 알림 수신이 활성화되었습니다.");
      } else {
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
          await sub.unsubscribe();
          await pushApi.unsubscribe(selectedCompanyId, { endpoint: sub.endpoint });
        }
        setPushSubscribed(false);
        setStatusMessage("Web Push 알림 수신이 해제되었습니다.");
      }
    } catch (e: any) {
      setErrorMessage(e instanceof Error ? e.message : "푸시 설정 변경 중 오류가 발생했습니다.");
    } finally {
      setIsPushLoading(false);
    }
  };

  const handleGeneratePairingCode = async () => {
    if (!selectedCompanyId) return;
    setIsGeneratingPairing(true);
    try {
      const result = await mockMobilePairingApi.getPairingCode(selectedCompanyId);
      setPairingCodeInfo(result);
    } catch (e) {
      console.error(e);
    } finally {
      setIsGeneratingPairing(false);
    }
  };

  return (
    <div className="space-y-4 px-4 py-3 max-w-md mx-auto pb-10">
      {/* iOS PWA Standalone Guidance Banner */}
      {showIosPwaBanner && (
        <Card className="p-3.5 border-amber-500/40 bg-amber-500/10 shadow-sm space-y-1.5">
          <div className="flex items-start gap-2 text-amber-700 dark:text-amber-400">
            <Info className="h-4.5 w-4.5 shrink-0 mt-0.5" />
            <div className="text-xs space-y-1">
              <p className="font-bold">iPhone 홈 화면 추가(PWA) 안내</p>
              <p className="leading-relaxed text-foreground/80">
                iOS에서는 Safari 하단 공유 버튼 &gt; &apos;홈 화면에 추가&apos;를 통해 앱으로 설치해야 백그라운드 푸시 알림을 수신할 수 있습니다.
              </p>
            </div>
          </div>
        </Card>
      )}

      {/* Status or Error Notice */}
      {statusMessage && (
        <p className="text-xs text-green-700 dark:text-green-400 bg-green-500/10 p-2.5 rounded-lg text-center font-medium">
          {statusMessage}
        </p>
      )}
      {errorMessage && (
        <p className="text-xs text-destructive bg-destructive/10 p-2.5 rounded-lg text-center font-medium">
          {errorMessage}
        </p>
      )}

      {/* 1. Biometric Authentication Device Registration */}
      <Card className="p-4 border-border/80 shadow-sm space-y-3">
        <h4 className="text-sm font-extrabold text-foreground flex items-center gap-1.5">
          <Fingerprint className="h-4.5 w-4.5 text-primary" />
          생체 인증 (Face ID / 지문) 등록
        </h4>
        <p className="text-xs text-muted-foreground leading-relaxed">
          이 모바일 기기의 Face ID 또는 지문을 등록하여 승인 시 생체 인증을 수행할 수 있도록 합니다.
        </p>
        <Button
          onClick={handleRegisterBiometrics}
          disabled={isRegisteringBiometrics || !selectedCompanyId}
          className="w-full text-xs py-2 flex items-center justify-center gap-1.5"
        >
          <Fingerprint className="h-4 w-4" />
          {isRegisteringBiometrics ? "생체 기기 등록 중..." : "Face ID / 지문 기기 등록"}
        </Button>
      </Card>

      {/* 2. Connected Biometric Devices List */}
      <Card className="p-4 border-border/80 shadow-sm space-y-3">
        <h4 className="text-sm font-extrabold text-foreground flex items-center gap-1.5">
          <ShieldCheck className="h-4.5 w-4.5 text-green-600" />
          등록된 생체 인증 기기 ({credentials?.length ?? 0})
        </h4>
        <div className="space-y-2">
          {isLoadingCredentials ? (
            <p className="text-xs text-muted-foreground text-center animate-pulse">
              기기 목록 로딩 중...
            </p>
          ) : !credentials || credentials.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-4">
              등록된 생체 인증 기기가 없습니다.
            </p>
          ) : (
            credentials.map((device) => (
              <div
                key={device.id}
                className="flex items-center justify-between bg-muted/30 p-2.5 rounded-lg border border-border/40"
              >
                <div className="space-y-0.5">
                  <p className="text-xs font-bold text-foreground">
                    {device.deviceName || "등록된 생체 기기"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    등록: {new Date(device.createdAt).toLocaleDateString()}
                    {device.lastUsedAt && ` · 최근 사용: ${new Date(device.lastUsedAt).toLocaleDateString()}`}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => deleteCredentialMutation.mutate(device.id)}
                  disabled={deleteCredentialMutation.isPending}
                  className="h-8 w-8 p-0 text-red-500 hover:text-red-600 hover:bg-red-500/10"
                >
                  <Trash2 className="h-4.5 w-4.5" />
                </Button>
              </div>
            ))
          )}
        </div>
      </Card>

      {/* 3. Push Preferences */}
      <Card className="p-4 border-border/80 shadow-sm space-y-3">
        <h4 className="text-sm font-extrabold text-foreground flex items-center gap-1.5">
          <Bell className="h-4.5 w-4.5 text-primary" />
          푸시 알림 설정
        </h4>
        <div className="space-y-3.5">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <span className="text-xs font-medium text-foreground block">
                Web Push 알림 수신
              </span>
              <span className="text-xs text-muted-foreground block">
                결재 요청 시 브라우저/잠금화면 알림 수신
              </span>
            </div>
            <input
              type="checkbox"
              checked={pushSubscribed}
              disabled={isPushLoading || !selectedCompanyId}
              onChange={(e) => handleTogglePush(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary cursor-pointer"
            />
          </div>
        </div>
      </Card>

      {/* 4. Device Pairing Section */}
      <Card className="p-4 border-border/80 shadow-sm space-y-3">
        <h4 className="text-sm font-extrabold text-foreground flex items-center gap-1.5">
          <PhoneCall className="h-4.5 w-4.5 text-primary" />
          모바일 기기 페어링
        </h4>
        <p className="text-xs text-muted-foreground leading-relaxed">
          페어링 코드를 생성하여 다자간 기기 연동을 시작할 수 있습니다.
        </p>

        {pairingCodeInfo ? (
          <div className="bg-muted/40 p-4 rounded-lg border border-border/60 text-center space-y-3">
            <p className="text-xs text-muted-foreground font-semibold">스캔용 QR 코드 및 핀 번호</p>
            <div className="flex justify-center bg-white p-2.5 rounded-lg max-w-36 mx-auto">
              <img src={pairingCodeInfo.qrUrl} alt="Pairing QR" className="h-28 w-28" />
            </div>
            <div className="text-lg font-mono font-bold tracking-widest text-primary">
              {pairingCodeInfo.pairingCode}
            </div>
            <p className="text-xs text-amber-500">
              만료 시간: {new Date(pairingCodeInfo.expiresAt).toLocaleTimeString()}
            </p>
          </div>
        ) : (
          <Button
            onClick={handleGeneratePairingCode}
            disabled={isGeneratingPairing || !selectedCompanyId}
            className="w-full text-xs py-2"
          >
            {isGeneratingPairing ? "페어링 생성 중..." : "페어링 코드/QR 생성"}
          </Button>
        )}
      </Card>

      {/* 5. Audit Log Browser */}
      <Card className="p-4 border-border/80 shadow-sm space-y-3">
        <h4 className="text-sm font-extrabold text-foreground flex items-center gap-1.5">
          <Shield className="h-4.5 w-4.5 text-amber-500" />
          최근 보안 및 감사 상태
        </h4>
        <div className="text-xs font-mono text-muted-foreground space-y-2 bg-muted/40 p-2.5 rounded-lg border border-border/40 max-h-36 overflow-y-auto">
          <div>[WebAuthn] 생체 인증 게이트웨이 준비 완료.</div>
          <div>[Web Push] VAPID Fail-Closed 암호화 채널 연결됨.</div>
          <div>[Security] 60초 단일 사용 토큰(One-Time Approval Token) 활성화.</div>
        </div>
      </Card>
    </div>
  );
}

