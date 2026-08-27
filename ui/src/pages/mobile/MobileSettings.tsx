import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "../../context/CompanyContext";
import { useBreadcrumbs } from "../../context/BreadcrumbContext";
import { mockMobilePairingApi, PairedDevice } from "../../lib/mobile/mobile-pairing-mock";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ShieldCheck, PhoneCall, Trash2, Bell, Shield } from "lucide-react";

export function MobileSettings() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  const [pairingCodeInfo, setPairingCodeInfo] = useState<any>(null);
  const [isGeneratingPairing, setIsGeneratingPairing] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(true);
  const [criticalOnly, setCriticalOnly] = useState(false);

  useEffect(() => {
    setBreadcrumbs([{ label: "모바일 설정" }]);
  }, [setBreadcrumbs]);

  // Query paired devices
  const { data: devices, isLoading: isLoadingDevices } = useQuery<PairedDevice[]>({
    queryKey: ["paired-devices", selectedCompanyId],
    queryFn: () => mockMobilePairingApi.listDevices(selectedCompanyId || ""),
    enabled: !!selectedCompanyId
  });

  const unpairMutation = useMutation({
    mutationFn: (id: string) => mockMobilePairingApi.unpairDevice(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["paired-devices", selectedCompanyId] });
    }
  });

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
      {/* 1. Device Pairing Section */}
      <Card className="p-4 border-border/80 shadow-sm space-y-3">
        <h4 className="text-sm font-extrabold text-foreground flex items-center gap-1.5">
          <PhoneCall className="h-4.5 w-4.5 text-primary" />
          모바일 기기 페어링
        </h4>
        <p className="text-xs text-muted-foreground leading-relaxed">
          이 모바일 콘솔을 대표자 기기로 정식 등록하거나 페어링 코드를 생성하여 다자간 연동을 시작할 수 있습니다.
        </p>

        {pairingCodeInfo ? (
          <div className="bg-muted/40 p-4 rounded-lg border border-border/60 text-center space-y-3">
            <p className="text-xs text-muted-foreground font-semibold">스캔용 QR 코드 및 핀 번호</p>
            <div className="flex justify-center bg-white p-2.5 rounded-lg max-w-[150px] mx-auto">
              <img src={pairingCodeInfo.qrUrl} alt="Pairing QR" className="h-28 w-28" />
            </div>
            <div className="text-lg font-mono font-bold tracking-widest text-primary">
              {pairingCodeInfo.pairingCode}
            </div>
            <p className="text-[10px] text-amber-500">
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

      {/* 2. Connected Devices List */}
      <Card className="p-4 border-border/80 shadow-sm space-y-3">
        <h4 className="text-sm font-extrabold text-foreground flex items-center gap-1.5">
          <ShieldCheck className="h-4.5 w-4.5 text-green-600" />
          연결된 승인 기기 목록
        </h4>
        <div className="space-y-2">
          {isLoadingDevices ? (
            <p className="text-xs text-muted-foreground text-center animate-pulse">기기 목록 로딩 중...</p>
          ) : !devices || devices.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-4">연결된 기기가 없습니다.</p>
          ) : (
            devices.map((device) => (
              <div
                key={device.deviceId}
                className="flex items-center justify-between bg-muted/30 p-2.5 rounded-lg border border-border/40"
              >
                <div className="space-y-0.5">
                  <p className="text-xs font-bold text-foreground">{device.deviceName}</p>
                  <p className="text-[10px] text-muted-foreground">
                    등록: {new Date(device.pairedAt).toLocaleDateString()}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => unpairMutation.mutate(device.deviceId)}
                  disabled={unpairMutation.isPending}
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
            <span className="text-xs font-medium text-foreground">푸시 알림 수신 허용</span>
            <input
              type="checkbox"
              checked={pushEnabled}
              onChange={(e) => setPushEnabled(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
            />
          </div>
          <div className="flex items-center justify-between border-t border-border/40 pt-2.5">
            <span className="text-xs font-medium text-foreground">CRITICAL / HIGH 위험도만 수신</span>
            <input
              type="checkbox"
              checked={criticalOnly}
              onChange={(e) => setCriticalOnly(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
            />
          </div>
        </div>
      </Card>

      {/* 4. Audit Log Browser */}
      <Card className="p-4 border-border/80 shadow-sm space-y-3">
        <h4 className="text-sm font-extrabold text-foreground flex items-center gap-1.5">
          <Shield className="h-4.5 w-4.5 text-amber-500" />
          최근 보안 및 감사 로그
        </h4>
        <div className="text-[11px] font-mono text-muted-foreground space-y-2 bg-muted/40 p-2.5 rounded-lg border border-border/40 max-h-36 overflow-y-auto">
          <div>[20:12:04] Device paired successfully (iPhone 15 Pro).</div>
          <div>[19:45:12] Approval ID `app-820` decided: STATUS=approved.</div>
          <div>[18:30:00] Emergency Stop triggered by CEO 서대곤.</div>
        </div>
      </Card>
    </div>
  );
}
