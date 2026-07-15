import type { Attachment } from './types/missive.js';

export function attachmentContentType(attachment: Attachment): string {
  if (attachment.content_type) return attachment.content_type;
  if (attachment.media_type && attachment.sub_type) {
    return `${attachment.media_type}/${attachment.sub_type}`;
  }
  return 'application/octet-stream';
}

export function summarizeAttachment(attachment: Attachment) {
  return {
    id: attachment.id,
    filename: attachment.filename,
    size: attachment.size,
    extension: attachment.extension,
    content_type: attachmentContentType(attachment),
    width: attachment.width,
    height: attachment.height,
  };
}
