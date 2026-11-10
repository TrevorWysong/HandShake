import { useRef, useState, type ReactNode } from "react";
import { Camera, ImageIcon, Loader2 } from "lucide-react";
import clsx from "clsx";
import { fileToResizedDataUri } from "../lib/ui/image";
import { useT } from "../i18n";
import { useAction } from "../lib/hooks/useAction";
import { Sheet } from "./Sheet";
import { CameraCapture } from "./CameraCapture";

interface Props {
  value: string;
  onChange: (dataUri: string) => void;
  shape?: "circle" | "banner";
  className?: string;
  /// Offer the camera too, as the delivery apps' sign-up does: "user" for a
  /// selfie, "environment" for a photo of something.
  camera?: "user" | "environment";
}

export function PhotoInput({ value, onChange, shape = "circle", className, camera }: Props) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const action = useAction();
  // With a camera: choosing how, then the camera itself.
  const [sheet, setSheet] = useState<"choose" | "camera" | null>(null);

  function pickFile() {
    setSheet(null);
    inputRef.current?.click();
  }

  function handleFile(file: File | undefined) {
    if (!file) return;
    return action.run(async () => {
      onChange(await fileToResizedDataUri(file));
    });
  }

  const isBanner = shape === "banner";

  return (
    <div className={clsx(isBanner && "w-full", className)}>
      <button
        type="button"
        onClick={() => (camera ? setSheet("choose") : inputRef.current?.click())}
        className={clsx(
          "group relative flex items-center justify-center overflow-hidden transition",
          isBanner
            ? clsx(
                "h-36 w-full rounded-2xl border-2",
                value
                  ? "border-transparent"
                  : "border-dashed border-ink-200 dark:border-ink-700 bg-ink-50/80 dark:bg-ink-800/50 hover:border-handshake-400 hover:bg-handshake-50/40 dark:hover:bg-handshake-900/10",
              )
            : "h-24 w-24 rounded-full bg-ink-100 dark:bg-ink-800 hover:opacity-90",
        )}
      >
        {value ? (
          <img src={value} alt="" className="h-full w-full object-cover" />
        ) : isBanner ? (
          <span className="flex flex-col items-center gap-1.5 text-ink-400 dark:text-ink-500">
            <Camera size={26} />
            <span className="text-xs font-semibold">{t("photo.add")}</span>
            <span className="text-[11px]">{t(camera ? "photo.tapCamera" : "photo.tap")}</span>
          </span>
        ) : (
          <Camera size={22} className="text-ink-400" />
        )}
        {action.busy && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/30">
            <Loader2 size={20} className="animate-spin text-white" />
          </div>
        )}
        {!action.busy && value && (
          <span className="absolute bottom-2 right-2 flex items-center gap-1 rounded-full bg-black/60 px-2 py-1 text-[10px] font-semibold text-white backdrop-blur-sm transition group-hover:bg-black/75">
            <Camera size={11} /> {t("photo.change")}
          </span>
        )}
      </button>
      <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={(e) => handleFile(e.target.files?.[0])} />
      {camera && (
        <Sheet open={sheet !== null} onClose={() => setSheet(null)} title={t(sheet === "camera" ? (camera === "user" ? "camera.selfieTitle" : "camera.title") : "photo.add")}>
          {sheet === "camera" ? (
            <CameraCapture
              facing={camera}
              onPickInstead={pickFile}
              onUse={(dataUri) => {
                onChange(dataUri);
                setSheet(null);
              }}
            />
          ) : (
            <div className="flex flex-col gap-2">
              <ChoiceRow icon={<Camera size={18} />} label={t("photo.take")} onClick={() => setSheet("camera")} />
              <ChoiceRow icon={<ImageIcon size={18} />} label={t("photo.library")} onClick={pickFile} />
            </div>
          )}
        </Sheet>
      )}
      {action.error && <p className="mt-1 text-[11px] text-red-600 dark:text-red-400">{action.error}</p>}
    </div>
  );
}

function ChoiceRow({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex items-center gap-3 rounded-2xl bg-ink-50 px-4 py-3.5 text-left text-sm font-semibold text-ink-900 transition hover:bg-ink-100 active:scale-[0.99] dark:bg-ink-800/60 dark:text-ink-50 dark:hover:bg-ink-800">
      <span className="grid h-10 w-10 place-items-center rounded-full bg-white text-handshake-600 shadow-sm dark:bg-ink-900 dark:text-handshake-400">{icon}</span>
      {label}
    </button>
  );
}
