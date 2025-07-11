import { useState, useEffect, type ChangeEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { RecordType, DNSRecord } from '@/types/dns';
import { Edit2, Trash2, Save, X } from 'lucide-react';

export interface RecordRowProps {
  record: DNSRecord;
  isEditing: boolean;
  onEdit: () => void;
  onSave: (record: DNSRecord) => void;
  onCancel: () => void;
  onDelete: () => void;
}

export function RecordRow({ record, isEditing, onEdit, onSave, onCancel, onDelete }: RecordRowProps) {
  const [editedRecord, setEditedRecord] = useState(record);

  useEffect(() => {
    setEditedRecord(record);
  }, [record]);

  if (isEditing) {
    return (
      <div className="p-4 border rounded-lg bg-muted/50">
        <div className="grid grid-cols-12 gap-4 items-center">
          <div className="col-span-2">
            <Select
              value={editedRecord.type}
              onValueChange={(value: RecordType) => setEditedRecord({
                ...editedRecord,
                type: value
              })}
            >
              <SelectTrigger className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {['A','AAAA','CNAME','MX','TXT','SRV','NS','PTR','CAA'].map((type: RecordType) => (
                  <SelectItem key={type} value={type}>
                    {type}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="col-span-3">
            <Input
              value={editedRecord.name}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setEditedRecord({
                ...editedRecord,
                name: e.target.value
              })}
              className="h-8"
            />
          </div>
          <div className="col-span-4">
            <Input
              value={editedRecord.content}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setEditedRecord({
                ...editedRecord,
                content: e.target.value
              })}
              className="h-8"
            />
          </div>
          <div className="col-span-1 space-y-1">
            <Input
              type="number"
              value={editedRecord.ttl}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setEditedRecord({
                  ...editedRecord,
                  ttl: parseInt(e.target.value) || 300,
                })
              }
              className="h-8"
            />
            {editedRecord.type === 'MX' && (
              <Input
                type="number"
                value={editedRecord.priority ?? ''}
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  setEditedRecord({
                    ...editedRecord,
                    priority: e.target.value ? parseInt(e.target.value) : undefined,
                  })
                }
                className="h-8"
              />
            )}
          </div>
          <div className="col-span-1">
            {(editedRecord.type === 'A' || editedRecord.type === 'AAAA' || editedRecord.type === 'CNAME') && (
              <Switch
                checked={editedRecord.proxied || false}
                onCheckedChange={(checked: boolean) => setEditedRecord({
                  ...editedRecord,
                  proxied: checked
                })}
              />
            )}
          </div>
          <div className="col-span-1 flex gap-1">
            <Button
              size="sm"
              onClick={() => onSave(editedRecord)}
              className="h-8 w-8 p-0"
            >
              <Save className="h-3 w-3" />
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={onCancel}
              className="h-8 w-8 p-0"
            >
              <X className="h-3 w-3" />
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 border rounded-lg hover:bg-muted/50 transition-colors">
      <div className="grid grid-cols-12 gap-4 items-center">
        <div className="col-span-2">
          <span className="inline-flex items-center px-2 py-1 rounded-md text-xs font-medium bg-primary/10 text-primary">
            {record.type}
          </span>
        </div>
        <div className="col-span-3">
          <span className="font-mono text-sm">{record.name}</span>
        </div>
        <div className="col-span-4">
          <span className="font-mono text-sm break-all">{record.content}</span>
        </div>
        <div className="col-span-1">
          <span className="text-sm text-muted-foreground">{record.ttl}</span>
        </div>
        <div className="col-span-1">
          {record.proxied && (
            <span className="inline-flex items-center px-2 py-1 rounded-md text-xs font-medium bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200">
              Proxied
            </span>
          )}
        </div>
        <div className="col-span-1 flex gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={onEdit}
            className="h-8 w-8 p-0"
          >
            <Edit2 className="h-3 w-3" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={onDelete}
            className="h-8 w-8 p-0 text-destructive hover:text-destructive"
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </div>
    </div>
  );
}
