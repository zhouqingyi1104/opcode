import React from "react";
import { motion } from "framer-motion";
import { X, FileText, Image as ImageIcon, Film, Music, FileQuestion, Loader2, AlertCircle, ExternalLink } from "lucide-react";
import type { FilePreview } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface FilePreviewPanelProps {
  /** Link target as it appeared in the message (may be relative) */
  target: string;
  preview: FilePreview | null;
  isLoading: boolean;
  error: string | null;
  onClose: () => void;
  className?: string;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function KindIcon({ kind }: { kind: string }) {
  const cls = "h-4 w-4 text-muted-foreground";
  switch (kind) {
    case "image":
      return <ImageIcon className={cls} />;
    case "video":
      return <Film className={cls} />;
    case "audio":
      return <Music className={cls} />;
    case "text":
      return <FileText className={cls} />;
    default:
      return <FileQuestion className={cls} />;
  }
}

/**
 * Right-hand preview for a file linked from a message.
 *
 * Text is rendered as plain selectable text (not markdown) so nothing is
 * interpreted; media is inlined as a data URL by the backend.
 */
export const FilePreviewPanel: React.FC<FilePreviewPanelProps> = ({
  target,
  preview,
  isLoading,
  error,
  onClose,
  className,
}) => {
  return (
    <motion.div
      initial={{ opacity: 0, x: 16 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 16 }}
      transition={{ duration: 0.18 }}
      className={cn(
        "flex h-full w-full min-w-0 flex-col border-l border-border bg-background",
        className
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <KindIcon kind={preview?.kind ?? "binary"} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-body-small font-medium">
            {preview?.display_name ?? target.split(/[\\/]/).pop() ?? target}
          </p>
          <p className="truncate text-caption text-muted-foreground">
            {preview ? `${preview.kind} · ${formatSize(preview.size)}` : target}
            {preview?.truncated ? " · truncated" : ""}
          </p>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} title="Close preview">
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto p-3">
        {isLoading && (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        )}

        {!isLoading && error && (
          <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
            <AlertCircle className="h-6 w-6 text-destructive" />
            <p className="text-sm text-destructive">{error}</p>
            <p className="text-caption text-muted-foreground break-all">{target}</p>
          </div>
        )}

        {!isLoading && !error && preview && (
          <>
            {preview.kind === "text" && (
              <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground">
                {preview.text}
              </pre>
            )}

            {preview.kind === "image" && preview.data_url && (
              <img
                src={preview.data_url}
                alt={preview.display_name}
                className="mx-auto max-w-full rounded-md"
              />
            )}

            {preview.kind === "video" && preview.data_url && (
              <video
                src={preview.data_url}
                controls
                className="mx-auto max-h-full max-w-full rounded-md"
              />
            )}

            {preview.kind === "audio" && preview.data_url && (
              <audio src={preview.data_url} controls className="w-full" />
            )}

            {((preview.kind === "binary") ||
              (["image", "video", "audio"].includes(preview.kind) && !preview.data_url)) && (
              <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
                <FileQuestion className="h-6 w-6 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  {preview.kind === "binary"
                    ? "No inline preview for this file type."
                    : "File is too large to preview inline."}
                </p>
                <p className="break-all text-caption text-muted-foreground">{preview.path}</p>
              </div>
            )}
          </>
        )}
      </div>

      {/* Footer */}
      {preview && (
        <div className="border-t border-border px-3 py-2">
          <p className="flex items-center gap-1 truncate text-caption text-muted-foreground" title={preview.path}>
            <ExternalLink className="h-3 w-3 shrink-0" />
            {preview.path}
          </p>
        </div>
      )}
    </motion.div>
  );
};
