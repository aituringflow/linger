"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { ModelMeta } from "./ModelSelect.tsx";

export interface DiscoveredModel { id: string; name?: string; meta?: ModelMeta; custom?: boolean; supportsImages?: boolean }
export interface DiscoveredFramework { id: string; name: string; models: DiscoveredModel[]; error?: string }
interface DiscoveryState { frameworks: DiscoveredFramework[]; loading: boolean; error: string; refresh: () => void }
const DiscoveryContext = createContext<DiscoveryState | null>(null);

/** Hosts configure discovery once; picker instances share the result. */
export function FrameworkModelProvider({ discover, children }: { discover: () => Promise<DiscoveredFramework[]>; children: ReactNode }) {
  const [frameworks, setFrameworks] = useState<DiscoveredFramework[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    let active = true;
    setLoading(true);
    void discover().then(result => { if (active) { setFrameworks(result); setError(""); } }).catch(reason => { if (active) setError(String(reason)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [discover, revision]);
  return <DiscoveryContext.Provider value={{ frameworks, loading, error, refresh }}>{children}</DiscoveryContext.Provider>;
}

export function useFrameworkModelDiscovery(): DiscoveryState | null { return useContext(DiscoveryContext); }
