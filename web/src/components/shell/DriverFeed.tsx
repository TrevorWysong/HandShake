// A driver's feed while they're online, on whichever screen they're on:
// open orders near them read as often as a driver app reads them, a ring
// for each new one, and their bid-for-me rule answered -- not only while
// their dashboard is open. It looks where they are (their device's location,
// kept on it), or round their saved address without it. Offline, it reads
// nothing, and follows no location.
import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { myAgentPubKey } from "../../holochain/client";
import { bytesToHex } from "../../holochain/decode";
import { encodeGeohash } from "../../lib/places/geohash";
import { bidAutomatically, fetchOffered } from "../../lib/driving/feed";
import { ringForOffers } from "../../lib/driving/offerAlert";
import { usePolling } from "../../lib/hooks/useResource";
import { POLL } from "../../lib/network/poll";
import { feedRead, useDriverFeed } from "../../store/driverFeed";
import { useTerms } from "../../store/network";
import { useSession } from "../../store/session";
import { useDriverLocation, watchDriverPosition } from "../../store/driverPosition";
import { useCarrying } from "../../store/carrying";

export function DriverFeed() {
  const me = useSession((s) => s.agentPubKey);
  const driverHex = me ? bytesToHex(me) : null;
  const online = useDriverFeed((s) => !!driverHex && s.driver === driverHex);
  return online && driverHex ? <OnlineFeed driverHex={driverHex} /> : null;
}

function OnlineFeed({ driverHex }: { driverHex: string }) {
  // Where they are while they're online, or their saved address.
  useEffect(() => watchDriverPosition(), []);
  const location = useDriverLocation(useSession((s) => s.location));
  const geohash = encodeGeohash(location.lat, location.lon);
  const terms = useTerms();
  const looking = useLocation().pathname === "/driver";
  const navigate = useNavigate();
  // Drivers find orders by looking, never by announcing where they are (see
  // dispatch `matching`) -- so while online, look often, and keep looking
  // with the app behind, so a new order still rings.
  usePolling(
    async () => {
      const offered = await fetchOffered(geohash, myAgentPubKey());
      ringForOffers(feedRead(driverHex, geohash, offered, looking && document.visibilityState === "visible"), () => navigate("/driver"));
      const carrying = useCarrying.getState();
      await bidAutomatically(driverHex, offered, carrying.driver === driverHex ? carrying.rows : undefined, location, terms);
    },
    { pollMs: POLL.driverFeed, background: true },
    true,
    geohash,
  );
  return null;
}
