/**
 * Monitoring Window Helper
 *
 * Implements the time-based component of the "Double-Lock" security system.
 * The monitoring window defines the period during which data ingestion is allowed.
 *
 * actualStart = event.startTime - monitoringStartOffset
 * actualEnd   = event.endTime   + monitoringEndOffset
 */

export interface MonitoringWindow {
  actualStart: Date;
  actualEnd: Date;
  isOpen: boolean;
  status: 'WAITING_FOR_WINDOW' | 'READY_TO_START' | 'LIVE' | 'FINISHED';
}

export interface EventForMonitoring {
  startTime: Date | null;
  endTime: Date | null;
  monitoringStartOffset: number; // in minutes
  monitoringEndOffset: number; // in minutes
  status: string;
}

/**
 * Calculates the monitoring window boundaries for an event.
 * Returns null if startTime or endTime are not set.
 */
export function getMonitoringWindow(event: EventForMonitoring): MonitoringWindow | null {
  if (!event.startTime || !event.endTime) {
    return null;
  }

  const actualStart = new Date(event.startTime.getTime() - event.monitoringStartOffset * 60 * 1000);
  const actualEnd = new Date(event.endTime.getTime() + event.monitoringEndOffset * 60 * 1000);
  const now = new Date();

  const isOpen = now >= actualStart && now <= actualEnd;

  let status: MonitoringWindow['status'];
  if (event.status === 'FINISHED') {
    status = 'FINISHED';
  } else if (event.status === 'LIVE') {
    status = 'LIVE';
  } else if (now >= actualStart) {
    status = 'READY_TO_START';
  } else {
    status = 'WAITING_FOR_WINDOW';
  }

  return { actualStart, actualEnd, isOpen, status };
}

/**
 * Checks if the monitoring window is currently open for an event.
 * Returns false if startTime or endTime are not configured.
 */
export function isMonitoringWindowOpen(event: EventForMonitoring): boolean {
  const window = getMonitoringWindow(event);
  return window ? window.isOpen : false;
}
