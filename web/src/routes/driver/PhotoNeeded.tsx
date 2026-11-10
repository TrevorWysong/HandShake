// A driver going online without a photo is asked for one first, as the
// delivery apps ask: customers see it with their first name, so they know
// who's at the door. Taken or picked here, and saved to their profile.
import { useState } from "react";
import { updateProfile, getMyName, getMyPhone } from "../../holochain/zomes/profiles";
import { useSession } from "../../store/session";
import { Button } from "../../components/ui";
import { Sheet } from "../../components/Sheet";
import { PhotoInput } from "../../components/PhotoInput";
import { useAction } from "../../lib/hooks/useAction";
import { useT } from "../../i18n";

export function PhotoNeeded({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const { profile, profileActionHash, refreshProfile } = useSession();
  const [photo, setPhoto] = useState("");
  const saving = useAction();

  const save = () => saving.run(async () => {
    if (!profile || !profileActionHash) return;
    // The rest of the profile as it is: the name and phone are sealed, so
    // they're read back to be written again.
    const [name, phone] = await Promise.all([getMyName(), getMyPhone()]);
    const { roles, created_at, bio } = profile;
    await updateProfile(profileActionHash, { display_name: name ?? profile.display_name, roles, created_at, bio, avatar_data_uri: photo, phone: phone ?? "" });
    await refreshProfile();
    onSaved();
  });

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t("drive.photoNeeded")}
      subtitle={t("onboarding.driverPhotoDetail")}
      footer={
        <Button className="w-full" disabled={!photo} loading={saving.busy} onClick={save}>
          {t("drive.photoSaveAndGo")}
        </Button>
      }
    >
      <div className="flex flex-col items-center gap-3 py-2">
        <PhotoInput value={photo} onChange={setPhoto} shape="circle" camera="user" />
        {saving.error && <p className="text-xs text-red-600 dark:text-red-400">{saving.error}</p>}
      </div>
    </Sheet>
  );
}
