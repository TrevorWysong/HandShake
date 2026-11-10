// Taking a photo with the device's camera, as the delivery apps' sign-up
// does: a live preview -- a face guide for a selfie, a frame for anything
// else -- one big shutter, then a look at the shot to retake or use. The
// camera runs only while the preview is on screen, and the shot goes
// through the same resizing as a picked file (`imageToDataUri`): nothing
// leaves the device until the person saves it.
import { useCallback, useState } from "react";
import { CameraOff, RotateCcw } from "lucide-react";
import clsx from "clsx";
import { imageToDataUri } from "../lib/ui/image";
import { t as translate, useT } from "../i18n";
import { Button } from "./ui";

interface Props {
  /// "user" for a selfie, the front camera; "environment" for the back.
  facing: "user" | "environment";
  onUse: (dataUri: string) => void;
  /// Pick a file instead -- offered when there's no camera to use.
  onPickInstead: () => void;
}

export function CameraCapture({ facing, onUse, onPickInstead }: Props) {
  const t = useT();
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [ready, setReady] = useState(false);
  const [shot, setShot] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const selfie = facing === "user";

  // The camera runs while its preview is mounted, and stops with it.
  const viewfinder = useCallback(
    (node: HTMLVideoElement | null) => {
      setVideo(node);
      if (!node) return;
      let stream: MediaStream | null = null;
      let stopped = false;
      (async () => {
        try {
          if (!navigator.mediaDevices?.getUserMedia) throw new Error("unsupported");
          stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facing }, width: { ideal: 1280 } }, audio: false });
          if (stopped) return stream.getTracks().forEach((track) => track.stop());
          node.srcObject = stream;
          await node.play();
          setReady(true);
        } catch (err) {
          if (stopped) return;
          const denied = err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "SecurityError");
          setProblem(translate(denied ? "camera.denied" : "camera.unavailable"));
        }
      })();
      return () => {
        stopped = true;
        setVideo(null);
        setReady(false);
        stream?.getTracks().forEach((track) => track.stop());
      };
    },
    [facing],
  );

  function capture() {
    if (!video || !video.videoWidth) return;
    try {
      setShot(imageToDataUri(video, video.videoWidth, video.videoHeight, selfie));
    } catch (err) {
      setProblem(err instanceof Error ? err.message : translate("camera.unavailable"));
    }
  }

  if (problem) {
    return (
      <div className="flex flex-col items-center gap-4 rounded-3xl bg-ink-50 px-6 py-10 text-center dark:bg-ink-800/60">
        <div className="grid h-14 w-14 place-items-center rounded-full bg-ink-100 dark:bg-ink-800">
          <CameraOff size={24} className="text-ink-400" />
        </div>
        <p className="text-sm text-ink-600 dark:text-ink-300">{problem}</p>
        <Button variant="secondary" onClick={onPickInstead}>
          {t("photo.library")}
        </Button>
      </div>
    );
  }

  if (shot) {
    return (
      <div className="flex flex-col items-center gap-5">
        <img src={shot} alt={t("camera.preview")} className={clsx("object-cover shadow-xl", selfie ? "aspect-square w-56 rounded-full" : "aspect-[4/3] w-full rounded-3xl")} />
        <div className="flex w-full gap-2">
          <Button variant="ghost" className="flex-1" onClick={() => setShot(null)}>
            <RotateCcw size={16} /> {t("camera.retake")}
          </Button>
          <Button className="flex-1" onClick={() => onUse(shot)}>
            {t("camera.use")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-5">
      <div className="relative aspect-[3/4] w-full overflow-hidden rounded-3xl bg-black">
        <video ref={viewfinder} muted playsInline className={clsx("h-full w-full object-cover transition-opacity duration-300", selfie && "-scale-x-100", ready ? "opacity-100" : "opacity-0")} />
        {/* The guide: an oval for a face, a frame for a car. */}
        <div aria-hidden className="pointer-events-none absolute inset-0 grid place-items-center">
          <div className={clsx("border-[3px] border-white/90 shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]", selfie ? "aspect-[3/4] w-[62%] rounded-[50%]" : "aspect-[4/3] w-[86%] rounded-3xl")} />
        </div>
        <p className="absolute inset-x-0 bottom-4 px-6 text-center text-xs font-semibold text-white drop-shadow">{t(selfie ? "camera.faceHint" : "camera.vehicleHint")}</p>
      </div>
      <button
        type="button"
        onClick={capture}
        disabled={!ready}
        aria-label={t("camera.shutter")}
        className="grid h-[72px] w-[72px] place-items-center rounded-full border-4 border-ink-900 transition active:scale-95 disabled:opacity-40 dark:border-white"
      >
        <span className="h-14 w-14 rounded-full bg-handshake-500 shadow-[var(--shadow-glow)]" />
      </button>
    </div>
  );
}
