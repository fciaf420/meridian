import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "@/lib/utils";

const Tabs = TabsPrimitive.Root;

function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn(
        "inline-flex w-full items-center gap-1 rounded-2xl border border-white/8 bg-[linear-gradient(180deg,rgba(18,69,89,0.72),rgba(1,22,30,0.88))] p-1.5 shadow-[inset_0_1px_0_rgba(239,246,224,0.05)]",
        className,
      )}
      {...props}
    />
  );
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        "inline-flex min-h-10 flex-1 items-center justify-center rounded-xl px-3 py-2 font-mono text-[11px] uppercase tracking-[0.16em] text-ash/70 transition-all",
        "hover:text-cream",
        "data-[state=active]:bg-cream/8 data-[state=active]:text-cream data-[state=active]:shadow-[0_10px_24px_rgba(0,0,0,0.22)] data-[state=active]:ring-1 data-[state=active]:ring-inset data-[state=active]:ring-white/10",
        "disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      className={cn("flex-1 overflow-hidden", className)}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent };
