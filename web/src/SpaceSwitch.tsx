import { Briefcase, House } from "lucide-react";
import { spaceNames, type Space } from "./api";

export const spaceIcons = { personal: House, work: Briefcase };
export const otherSpace = (space: Space): Space =>
  space === "work" ? "personal" : "work";

/** Personal or Work. The app shows one space at a time. */
export function SpaceSwitch({
  space,
  change,
  label = "Space",
}: {
  space: Space;
  change: (space: Space) => void;
  label?: string;
}) {
  return (
    <div className="space-switch" role="radiogroup" aria-label={label}>
      {(["personal", "work"] as const).map((s) => {
        const Icon = spaceIcons[s];
        return (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={space === s}
            className={space === s ? "is-selected" : ""}
            onClick={() => change(s)}
          >
            <Icon size={15} />
            {spaceNames[s]}
          </button>
        );
      })}
    </div>
  );
}
