import { cn } from "@/lib/utils";

interface ProgressProps extends React.ComponentProps<"div"> {
  value?: number;
  indicatorClassName?: string;
}

function Progress({ className, value = 0, indicatorClassName, ...props }: ProgressProps) {
  return (
    <div
      className={cn("relative h-1.5 w-full overflow-hidden rounded-full bg-ink/60", className)}
      {...props}
    >
      <div
        className={cn("h-full rounded-full bg-steel transition-all duration-300", indicatorClassName)}
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </div>
  );
}

export { Progress };
