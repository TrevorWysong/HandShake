// A customer telling the store their delivery itself let them down: what
// went wrong, a note and a photo, sealed to the store. Worth their share of
// the delivery fee; the store decides -- all, part or none -- and pays any
// refund itself, out of what it collects for the food. Never the driver.
import { useState } from "react";
import { ShieldCheck, Truck } from "lucide-react";
import { reportIssue } from "../../holochain/zomes/dispatch";
import { DELIVERY_REASONS, deliveryNote, detailsRoom, type DeliveryReason } from "../../lib/orders/deliveryReport";
import { formatCents } from "../../lib/ui/format";
import { useAction } from "../../lib/hooks/useAction";
import { Button, Chip, Notice, Textarea } from "../ui";
import { PhotoInput } from "../PhotoInput";
import { Sheet } from "../Sheet";
import { useT, type MessageKey } from "../../i18n";

const REASON_LABEL: Record<DeliveryReason, MessageKey> = {
  late: "deliveryReport.late",
  cold: "deliveryReport.cold",
  spilled: "deliveryReport.spilled",
  wrongPlace: "deliveryReport.wrongPlace",
  conduct: "deliveryReport.conduct",
};

export function DeliveryReportSheet({ open, onClose, orderRef, worth, onReported }: { open: boolean; onClose: () => void; orderRef: Uint8Array; worth: number; onReported: () => Promise<void> }) {
  const t = useT();
  const action = useAction();
  const [picked, setPicked] = useState<DeliveryReason[]>([]);
  const [details, setDetails] = useState("");
  const [photo, setPhoto] = useState("");
  const reasons = DELIVERY_REASONS.filter((r) => picked.includes(r)).map((r) => t(REASON_LABEL[r]));
  const room = detailsRoom(reasons);
  const ready = reasons.length > 0 || details.trim().length > 0;

  const toggle = (reason: DeliveryReason) => setPicked((now) => (now.includes(reason) ? now.filter((r) => r !== reason) : [...now, reason]));
  const submit = () => action.run(async () => {
    await reportIssue({ order: orderRef, lines: [], service: true, note: deliveryNote(reasons, details), photo_data_uri: photo });
    setPicked([]);
    setDetails("");
    setPhoto("");
    await onReported();
  });

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t("deliveryReport.title")}
      subtitle={t("deliveryReport.subtitle")}
      footer={
        <>
          {action.error && <Notice className="mb-2">{action.error}</Notice>}
          <Button className="w-full" disabled={!ready} loading={action.busy} onClick={submit}>
            {ready ? t("deliveryReport.send", { amount: formatCents(worth) }) : t("deliveryReport.pick")}
          </Button>
        </>
      }
    >
      <div className="flex items-start gap-3 rounded-2xl bg-handshake-50 p-3 dark:bg-handshake-900/20">
        <Truck size={18} className="mt-0.5 shrink-0 text-handshake-600 dark:text-handshake-400" aria-hidden />
        <p className="text-xs leading-relaxed text-ink-700 dark:text-ink-200">{t("deliveryReport.worth", { amount: formatCents(worth) })}</p>
      </div>

      <p className="mt-5 mb-2 text-xs font-semibold text-ink-500">{t("deliveryReport.what")}</p>
      <div className="flex flex-wrap gap-2" role="group" aria-label={t("deliveryReport.what")}>
        {DELIVERY_REASONS.map((reason) => (
          <Chip key={reason} active={picked.includes(reason)} onClick={() => toggle(reason)}>
            {t(REASON_LABEL[reason])}
          </Chip>
        ))}
      </div>

      <div className="mt-5">
        <p className="mb-2 text-xs font-semibold text-ink-500">{t("issues.tellMore")}</p>
        <Textarea value={details} maxLength={room} rows={3} placeholder={t("deliveryReport.placeholder")} onChange={(e) => setDetails(e.target.value.slice(0, room))} />
      </div>
      <div className="mt-4">
        <p className="mb-2 text-xs font-semibold text-ink-500">{t("issues.addPhoto")}</p>
        <PhotoInput value={photo} onChange={setPhoto} shape="banner" className="w-full" />
      </div>
      <p className="mt-4 flex items-start gap-2 text-[0.6875rem] leading-relaxed text-ink-400">
        <ShieldCheck size={13} className="mt-0.5 shrink-0" aria-hidden />
        {t("deliveryReport.privacy")}
      </p>
    </Sheet>
  );
}
