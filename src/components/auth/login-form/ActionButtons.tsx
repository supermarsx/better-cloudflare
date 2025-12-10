import { Button } from "@/components/ui/Button";

interface ActionButtonsProps {
  onAddKey: () => void;
  onSettings: () => void;
}

export function ActionButtons({ onAddKey, onSettings }: ActionButtonsProps) {
  return (
    <div className="grid grid-cols-2 gap-3 pt-2">
      <Button
        variant="secondary"
        size="sm"
        onClick={onAddKey}
        className="w-full bg-black/40 border border-orange-500/20 hover:bg-orange-500/10 hover:border-orange-500/40 text-orange-200/80"
      >
        Add New Key
      </Button>
      <Button
        variant="secondary"
        size="sm"
        onClick={onSettings}
        className="w-full bg-black/40 border border-orange-500/20 hover:bg-orange-500/10 hover:border-orange-500/40 text-orange-200/80"
      >
        Settings
      </Button>
    </div>
  );
}
