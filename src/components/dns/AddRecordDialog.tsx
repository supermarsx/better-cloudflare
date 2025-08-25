import type { ChangeEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import type { DNSRecord, RecordType } from '@/types/dns';
import { RECORD_TYPES, TTL_PRESETS } from '@/types/dns';
import { Plus } from 'lucide-react';

export interface AddRecordDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  record: Partial<DNSRecord>;
  onRecordChange: (record: Partial<DNSRecord>) => void;
  onAdd: () => void;
  zoneName?: string;
}

export function AddRecordDialog({ open, onOpenChange, record, onRecordChange, onAdd, zoneName }: AddRecordDialogProps) {
  const ttlValue = record.ttl === 1 ? 'auto' : record.ttl;
  const isCustomTTL =
    ttlValue !== undefined && !TTL_PRESETS.includes(ttlValue as any);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="h-4 w-4 mr-2" />
          Add Record
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add DNS Record</DialogTitle>
          <DialogDescription>
            Create a new DNS record for {zoneName}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Type</Label>
              <Select
                value={record.type}
                onValueChange={(value: string) =>
                  onRecordChange({
                    ...record,
                    type: value as RecordType,
                    priority: value === 'MX' ? record.priority : undefined
                  })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RECORD_TYPES.map((type) => (
                    <SelectItem key={type} value={type}>
                      {type}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>TTL</Label>
              <Select
                value={isCustomTTL ? 'custom' : String(ttlValue)}
                onValueChange={(value: string) => {
                  if (value === 'custom') {
                    onRecordChange({ ...record, ttl: 300 });
                  } else {
                    onRecordChange({
                      ...record,
                      ttl: value === 'auto' ? 'auto' : Number(value)
                    });
                  }
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TTL_PRESETS.map((ttl) => (
                    <SelectItem key={ttl} value={String(ttl)}>
                      {ttl === 'auto' ? 'Auto' : ttl}
                    </SelectItem>
                  ))}
                  <SelectItem value="custom">Custom</SelectItem>
                </SelectContent>
              </Select>
              {isCustomTTL && (
                <Input
                  type="number"
                  value={typeof record.ttl === 'number' ? record.ttl : ''}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                    const n = Number.parseInt(e.target.value, 10);
                    onRecordChange({
                      ...record,
                      ttl: Number.isNaN(n) ? 300 : n
                    });
                  }}
                />
              )}
            </div>
          </div>
          <div className="space-y-2">
            <Label>Name</Label>
            <Input
              value={record.name}
              onChange={(e: ChangeEvent<HTMLInputElement>) => onRecordChange({
                ...record,
                name: e.target.value
              })}
              placeholder="e.g., www or @ for root"
            />
          </div>
          <div className="space-y-2">
            <Label>Content</Label>
            <Input
              value={record.content}
              onChange={(e: ChangeEvent<HTMLInputElement>) => onRecordChange({
                ...record,
                content: e.target.value
              })}
              placeholder="e.g., 192.168.1.1"
            />
          </div>
          {record.type === 'MX' && (
            <div className="space-y-2">
              <Label>Priority</Label>
              <Input
                type="number"
                value={record.priority || ''}
                onChange={(e: ChangeEvent<HTMLInputElement>) => {
                  const n = Number.parseInt(e.target.value, 10);
                  onRecordChange({
                    ...record,
                    priority: Number.isNaN(n) ? undefined : n
                  });
                }}
              />
            </div>
          )}
          {(record.type === 'A' || record.type === 'AAAA' || record.type === 'CNAME') && (
            <div className="flex items-center space-x-2">
              <Switch
                checked={record.proxied || false}
                onCheckedChange={(checked: boolean) =>
                  onRecordChange({
                    ...record,
                    proxied: checked
                  })
                }
              />
              <Label>Proxied through Cloudflare</Label>
            </div>
          )}
          <Button onClick={onAdd} className="w-full">
            Create Record
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
