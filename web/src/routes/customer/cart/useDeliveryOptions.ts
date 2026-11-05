// How a delivery is to be made, as the customer chooses it at checkout:
// where to, how it's handed over, how fast, who picks the driver, when, and
// what they'll pay the driver at most and tip. It starts as they last left
// it (`useCustomerSettings().checkout`), the drop-off at their saved place --
// or, for a recurring order brought here to confirm, as it was set up.
import { useState } from "react";
import { useSession } from "../../../store/session";
import { useCustomerSettings } from "../../../store/roleSettings";
import { useTerms } from "../../../store/network";
import { fromMinorUnits } from "../../../lib/ui/format";
import type { DropoffPreference, GeoPoint } from "../../../holochain/types";
import type { CheckoutDraft } from "../../../lib/orders/recurring";

export function useDeliveryOptions(draft?: CheckoutDraft) {
  const location = useSession((s) => s.location);
  const feePresets = useTerms().suggested_delivery_fees;
  const [usual] = useState(() => {
    const last = useCustomerSettings.getState().checkout;
    return draft ? { ...last, dropoffPreference: draft.preference, priority: draft.priority, tipPercent: null, feeCapCents: draft.feeCapCents ?? last.feeCapCents } : last;
  });

  // Editable per order -- a friend's place, say -- and kept as the default
  // only if asked.
  const [dropoff, setDropoff] = useState<GeoPoint>(draft?.dropoff ?? location);
  // Its second line -- the apartment, suite or unit -- typed, or a saved
  // address's own.
  const [dropoffLine2, setDropoffLine2] = useState(draft?.dropoffLine2 ?? "");
  const [saveAsDefault, setSaveAsDefault] = useState(false);
  const [chosenPreference, setChosenPreference] = useState<DropoffPreference>(usual.dropoffPreference);
  // Leaving it at the door means accepting it's delivered once it's left --
  // asked each time it's chosen.
  const [doorRiskAccepted, setDoorRiskAccepted] = useState(false);
  const [priority, setPriority] = useState(usual.priority);
  const [autoMatch, setAutoMatch] = useState(usual.autoMatch);
  const [scheduled, setScheduled] = useState(false);
  const [scheduledFor, setScheduledFor] = useState("");
  const [tipPercent, setTipPercent] = useState<number | null>(usual.tipPercent);
  const [customTip, setCustomTip] = useState(draft ? String(fromMinorUnits(draft.tipCents)) : "");
  // The last cap, as a preset if it's one, else typed in; at first, the
  // second suggestion.
  const [feePreset, setFeePreset] = useState<number | null>(() => {
    if (usual.feeCapCents !== null) return feePresets.includes(usual.feeCapCents) ? usual.feeCapCents : null;
    return feePresets[Math.min(1, feePresets.length - 1)];
  });
  const [customFee, setCustomFee] = useState(() => (usual.feeCapCents !== null && !feePresets.includes(usual.feeCapCents) ? String(fromMinorUnits(usual.feeCapCents)) : ""));

  return {
    feePresets,
    dropoff,
    setDropoff,
    dropoffLine2,
    setDropoffLine2,
    saveAsDefault,
    setSaveAsDefault,
    chosenPreference,
    /// Choosing how it's handed over asks again about the door.
    choosePreference: (preference: DropoffPreference) => {
      setChosenPreference(preference);
      setDoorRiskAccepted(false);
    },
    doorRiskAccepted,
    setDoorRiskAccepted,
    priority,
    setPriority,
    autoMatch,
    setAutoMatch,
    scheduled,
    setScheduled,
    scheduledFor,
    setScheduledFor,
    tipPercent,
    setTipPercent,
    customTip,
    setCustomTip,
    feePreset,
    setFeePreset,
    customFee,
    setCustomFee,
  };
}

export type DeliveryOptions = ReturnType<typeof useDeliveryOptions>;
