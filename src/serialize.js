/**
 * Serialisation helpers: convert internal store objects into safe,
 * client-facing JSON. Attachment bytes are never sent in list/detail
 * responses; they are fetched on demand from the download endpoint.
 */

export function toPublicMailbox(mailbox) {
  return {
    id: mailbox.id,
    address: mailbox.address,
    localPart: mailbox.localPart,
    domain: mailbox.domain,
    createdAt: mailbox.createdAt,
    expiresAt: mailbox.expiresAt,
    extendCount: mailbox.extendCount ?? 0,
    messageCount: mailbox.messages.length,
  };
}

function publicAttachments(message) {
  return (message.attachments ?? []).map((attachment, index) => ({
    index,
    filename: attachment.filename,
    contentType: attachment.contentType,
    size: attachment.size,
  }));
}

export function toPublicMessageSummary(message) {
  const text = message.text ?? '';
  return {
    id: message.id,
    from: message.from,
    to: message.to,
    subject: message.subject,
    date: message.date,
    receivedAt: message.receivedAt,
    size: message.size ?? 0,
    preview: text.replace(/\s+/g, ' ').slice(0, 160),
    hasHtml: Boolean(message.html),
    attachmentCount: (message.attachments ?? []).length,
    attachments: publicAttachments(message),
  };
}

export function toPublicMessage(message) {
  return {
    ...toPublicMessageSummary(message),
    text: message.text ?? '',
    html: message.html ?? '',
  };
}
