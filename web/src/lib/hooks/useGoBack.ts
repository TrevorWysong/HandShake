import { useLocation, useNavigate } from "react-router-dom";

/// The way back from a screen: to wherever it was reached from, or, opened
/// directly from a link with nothing to go back to, to `fallback`.
export function useGoBack(fallback: string): () => void {
  const navigate = useNavigate();
  const { key } = useLocation();
  return () => {
    if (key === "default") navigate(fallback, { replace: true });
    else navigate(-1);
  };
}
