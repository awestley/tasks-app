import { Check } from "lucide-react";

export function Logo() {
  return (
    <div className="brand" aria-hidden="true">
      <span className="brand-mark">
        <Check size={21} strokeWidth={3} />
      </span>
    </div>
  );
}
