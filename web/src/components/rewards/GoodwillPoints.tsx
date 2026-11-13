// Points a store gives a customer as an apology or a thank-you: amounts
// drawn from its own rewards ("Free coffee · 300"), any number up to a
// grant's most, and a short note -- shared by a report's answer and an
// order's "Give points". Only for a store running a program.
import { MAX_GRANT_NOTE_CHARS, MAX_GRANT_POINTS, type RewardsProgram } from "../../holochain/types";
import { goodwillChoices, pickedPoints, pointsIn } from "../../lib/orders/issueAnswer";
import { usePointsName } from "../../lib/hooks/useRunningProgram";
import { Chip, Input } from "../ui";
import { useT } from "../../i18n";

export function GoodwillPoints({ program, points, onPoints, note, onNote }: { program: RewardsProgram; points: number | null; onPoints: (points: number) => void; note: string; onNote: (note: string) => void }) {
  const t = useT();
  const name = usePointsName(program);
  const given = pickedPoints(program, points);
  return (
    <>
      <div className="flex flex-wrap gap-1.5">
        {goodwillChoices(program.rewards).map((choice) => (
          <Chip key={choice.points} active={given === choice.points} onClick={() => onPoints(choice.points)}>
            {choice.reward ? t("issueAnswer.enoughFor", { reward: choice.reward, points: choice.points.toLocaleString() }) : choice.points.toLocaleString()}
          </Chip>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <Input
          type="number"
          min={1}
          max={MAX_GRANT_POINTS}
          step={1}
          value={given ?? 0}
          onChange={(e) => {
            const typed = pointsIn(e.target.valueAsNumber);
            if (typed !== null) onPoints(typed);
          }}
          suffix={name}
          aria-label={t("issueAnswer.pointsLabel", { points: name })}
          className="min-w-0 flex-[1_1_8rem] py-1.5 text-sm"
        />
        <Input value={note} maxLength={MAX_GRANT_NOTE_CHARS} onChange={(e) => onNote(e.target.value)} aria-label={t("issueAnswer.noteLabel")} placeholder={t("issueAnswer.defaultNote")} className="min-w-0 flex-[2_1_12rem] py-1.5 text-sm" />
      </div>
    </>
  );
}
