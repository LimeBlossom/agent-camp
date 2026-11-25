import { useEffect, useState } from 'react';
import { MODEL_CATALOG_EVENT, refreshModelCatalog } from '@/store/config';

/** Re-read the model catalog from main when the calling picker mounts, and
 *  re-render it when the catalog changes, so a model added on disk shows the
 *  next time the picker opens with no restart. */
export function useLiveModelCatalog(): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    const onChange = () => setTick((n) => n + 1);
    window.addEventListener(MODEL_CATALOG_EVENT, onChange);
    void refreshModelCatalog();
    return () => window.removeEventListener(MODEL_CATALOG_EVENT, onChange);
  }, []);
}
