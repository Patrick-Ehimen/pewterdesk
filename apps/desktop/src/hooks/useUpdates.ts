import { useEffect, useState } from "react";
import { appClient, type UpdateStatus } from "../api/appClient";

/** Where updates stand, kept current from Rust (`updater.rs`). */
export function useUpdates(): UpdateStatus | undefined {
  const [status, setStatus] = useState<UpdateStatus>();
  useEffect(() => {
    let live = true;
    const stop = appClient.onUpdateStatus(setStatus);
    appClient.updateStatus().then(
      (s) => live && s && setStatus((current) => current ?? s),
      () => {},
    );
    return () => {
      live = false;
      stop();
    };
  }, []);
  return status;
}
