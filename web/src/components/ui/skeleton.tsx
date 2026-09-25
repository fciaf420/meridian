import { cn } from "@/lib/utils";

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("bg-teal/30 animate-pulse rounded-md", className)}
      {...props}
    />
  );
}

export { Skeleton };
