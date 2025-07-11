import { ChangeEvent } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import type { DNSRecord, RecordType } from '@/types/dns';
import { Plus } from 'lucide-react';

const RECORD_TYPES: RecordType[] = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'NS', 'PTR', 'CAA'];

interface AddRecordDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  record: Partial<DNSRecord>;
  onRecordChange: (record: Partial<DNSRecord>) => void;
  onAdd: () => void;
  zoneName?: string;
}

export function AddRecordDialog({
  open,
  onOpenChange,
  record,
  onRecordChange,
  onAdd,
  zoneName
}: AddRecordDialogProps) {
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
                  {RECORD_TYPES.map((type: RecordType) => (
                    <SelectItem key={type} value={type}>
                      {type}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>TTL</Label>
              <Input
                type="number"
                value={record.ttl}
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  onRecordChange({
                    ...record,
                    ttl: parseInt(e.target.value) || 300
                  })
                }
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Name</Label>
            <Input
              value={record.name}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                onRecordChange({
                  ...record,
                  name: e.target.value
                })
              }
              placeholder="e.g., www or @ for root"
            />
          </div>
          <div className="space-y-2">
            <Label>Content</Label>
            <Input
              value={record.content}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                onRecordChange({
                  ...record,
                  content: e.target.value
                })
              }
              placeholder="e.g., 192.168.1.1"
            />
          </div>
          {record.type === 'MX' && (
            <div className="space-y-2">
              <Label>Priority</Label>
              <Input
                type="number"
                value={record.priority || ''}
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  onRecordChange({
                    ...record,
                    priority: parseInt(e.target.value) || undefined
                  })
                }
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
