import { useState } from "react";
import { Check, Inbox, ShieldAlert, X, Zap } from "lucide-react";
import type { InboxItem } from "@shared/types";
import { api, useStore } from "../state/store";
import { Drawer } from "./Drawer";
import { Markdown } from "./MessageView";
import { OrbAvatar } from "./OrbAvatar";

function Asker({ id }: { id: string }) {
  const a = useStore((s) => s.project?.agents.find((x) => x.id === id));
  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs font-semibold"
      style={{ color: a?.color }}
    >
      <OrbAvatar
        color={a?.color ?? "#888"}
        size={16}
        brain={id === "mastermind"}
      />{" "}
      {a?.name ?? id}
    </span>
  );
}

function QuestionCard({ item }: { item: InboxItem }) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const qs = item.questions ?? [];
  const toggle = (q: string, label: string, multi?: boolean) =>
    setPicked((p) => {
      const cur = p[q] ?? [];
      return {
        ...p,
        [q]: multi
          ? cur.includes(label)
            ? cur.filter((x) => x !== label)
            : [...cur, label]
          : [label],
      };
    });
  const submit = () => {
    const answers: Record<string, string> = {};
    for (const q of qs)
      answers[q.question] = [
        ...(picked[q.question] ?? []),
        ...(other[q.question]?.trim() ? [other[q.question].trim()] : []),
      ].join(", ");
    void api().answer(item.id, answers);
  };
  const complete = qs.every(
    (q) => (picked[q.question]?.length ?? 0) > 0 || other[q.question]?.trim(),
  );
  return (
    <div className="space-y-4">
      {qs.map((q) => (
        <div key={q.question}>
          {q.header && (
            <span className="mb-1 inline-block rounded-full bg-violet-500/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-violet-200">
              {q.header}
            </span>
          )}
          <div className="mb-2 text-sm font-semibold">{q.question}</div>
          <div className="space-y-1.5">
            {q.options.map((o, i) => {
              const on = picked[q.question]?.includes(o.label);
              return (
                <button
                  key={o.label}
                  className={`w-full rounded-lg border px-3 py-2 text-left transition ${on ? "border-violet-400 bg-violet-500/20" : "border-white/10 bg-black/20 hover:border-white/25"}`}
                  onClick={() => toggle(q.question, o.label, q.multiSelect)}
                >
                  <div className="text-sm font-medium">
                    {o.label}
                    {i === 0 && (
                      <span className="ml-2 text-[10px] text-emerald-300">
                        first choice
                      </span>
                    )}
                  </div>
                  {o.description && (
                    <div className="mt-0.5 text-xs text-indigo-200/70">
                      {o.description}
                    </div>
                  )}
                </button>
              );
            })}
            <input
              className="field"
              placeholder="Other (type your own answer)"
              value={other[q.question] ?? ""}
              onChange={(e) =>
                setOther({ ...other, [q.question]: e.target.value })
              }
            />
          </div>
        </div>
      ))}
      <button
        className="btn btn-primary w-full justify-center"
        disabled={!complete}
        onClick={submit}
        data-testid="inbox-submit"
      >
        <Check size={14} /> Send answers
      </button>
    </div>
  );
}

function ApprovalCard({ item }: { item: InboxItem }) {
  const [note, setNote] = useState("");
  return (
    <div className="space-y-3">
      <div className="scroll-thin max-h-[45vh] overflow-y-auto rounded-lg border border-white/10 bg-black/30 p-3">
        <Markdown text={item.planMd ?? ""} />
      </div>
      {item.watchdog ? (
        <>
          <textarea
            className="field min-h-16"
            placeholder="Tell it what to do instead (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="flex gap-2">
            <button
              className="btn btn-primary flex-1 justify-center"
              disabled={!note.trim()}
              onClick={() => void api().decide(item.id, false, note.trim())}
            >
              Tell it
            </button>
            <button
              className="btn flex-1 justify-center"
              onClick={() => void api().decide(item.id, true)}
            >
              Continue
            </button>
            <button
              className="btn btn-danger flex-1 justify-center"
              onClick={() => void api().decide(item.id, false)}
            >
              Stop
            </button>
          </div>
        </>
      ) : (
        <>
          <textarea
            className="field min-h-16"
            placeholder="Feedback (sent back with your decision)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="flex gap-2">
            <button
              className="btn btn-primary flex-1 justify-center"
              onClick={() =>
                void api().decide(item.id, true, note || undefined)
              }
              data-testid="inbox-approve"
            >
              <Check size={14} /> Approve
            </button>
            {item.alwaysLabel && (
              <button
                className="btn flex-1 justify-center"
                onClick={() =>
                  void api().decide(item.id, true, note || undefined, true)
                }
              >
                <Check size={14} /> {item.alwaysLabel}
              </button>
            )}
            <button
              className="btn btn-danger flex-1 justify-center"
              onClick={() =>
                void api().decide(item.id, false, note || undefined)
              }
            >
              <X size={14} /> Reject
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export function InboxPanel() {
  const inbox = useStore((s) => s.inbox);
  const [tab, setTab] = useState<"pending" | "history">("pending");
  const pending = inbox.filter((i) => i.status === "pending");
  const history = inbox
    .filter((i) => i.status !== "pending")
    .slice()
    .reverse();
  const list = tab === "pending" ? pending : history;
  return (
    <Drawer
      title="Mastermind inbox"
      icon={<Inbox size={17} className="text-amber-300" />}
    >
      <div className="mb-4 flex gap-1 rounded-lg bg-black/30 p-1 text-xs">
        {(["pending", "history"] as const).map((t) => (
          <button
            key={t}
            className={`flex-1 rounded-md py-1.5 font-semibold capitalize ${tab === t ? "bg-violet-500/30 text-white" : "text-indigo-300"}`}
            onClick={() => setTab(t)}
          >
            {t} {t === "pending" && pending.length ? `(${pending.length})` : ""}
          </button>
        ))}
      </div>
      {list.length === 0 && (
        <div className="mt-8 text-center text-sm text-indigo-300/60">
          {tab === "pending"
            ? "Nothing is waiting on you."
            : "No answered items yet."}
        </div>
      )}
      <div className="space-y-4">
        {list.map((item) => (
          <div
            key={item.id}
            className={`rounded-xl border p-4 ${item.status === "pending" ? "border-amber-400/30 bg-amber-500/5" : "border-white/10 bg-black/20"}`}
          >
            <div className="mb-2 flex items-center gap-2">
              {item.kind === "approval" ? (
                <ShieldAlert size={15} className="text-orange-300" />
              ) : (
                <Inbox size={15} className="text-amber-300" />
              )}
              <Asker id={item.askedBy} />
              <span className="flex-1" />
              <span className="text-[10px] text-indigo-300/60">
                {new Date(item.ts).toLocaleTimeString()}
              </span>
            </div>
            <div className="mb-3 font-display text-sm font-bold">
              {item.title}
            </div>
            {item.status === "pending" ? (
              item.kind === "question" ? (
                <QuestionCard item={item} />
              ) : (
                <ApprovalCard item={item} />
              )
            ) : (
              <div className="space-y-1 text-xs">
                {item.kind === "approval" ? (
                  <div
                    className={
                      item.approved ? "text-emerald-300" : "text-red-300"
                    }
                  >
                    {item.approved ? "Approved" : "Rejected"}
                  </div>
                ) : (
                  Object.entries(item.answers ?? {}).map(([q, a]) => (
                    <div key={q}>
                      <span className="text-indigo-300/80">{q}</span>{" "}
                      <span className="font-semibold text-white">
                        {a || "-"}
                      </span>
                    </div>
                  ))
                )}
                {item.status === "auto" && item.autoReason && (
                  <div className="flex items-center gap-1 text-orange-300">
                    <Zap size={11} /> {item.autoReason}
                  </div>
                )}
                {item.note && (
                  <div className="text-indigo-200/70">Note: {item.note}</div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </Drawer>
  );
}
