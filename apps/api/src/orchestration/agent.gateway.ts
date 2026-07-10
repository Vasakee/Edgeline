import { OnEvent } from '@nestjs/event-emitter';
import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server } from 'socket.io';
import { Logger } from '@nestjs/common';
import { PositionDocument } from '../decision/schemas/position.schema';
import { PositionApprovedPayload } from '../decision/decision.service';
import { OpportunityDetectedPayload } from '../scanner/scanner.service';

@WebSocketGateway({
  cors: {
    origin: '*',
  },
})
export class AgentGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(AgentGateway.name);

  @WebSocketServer()
  server!: Server;

  handleConnection(client: any) {
    this.logger.log(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: any) {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  @OnEvent('opportunity.detected')
  handleOpportunityDetected(payload: OpportunityDetectedPayload) {
    this.logger.log(`Broadcasting opportunity.created for fixture=${payload.fixtureId}`);
    this.server.emit('opportunity.created', payload.opportunity);
  }

  @OnEvent('position.approved')
  handlePositionApproved(payload: PositionApprovedPayload) {
    this.logger.log(`Broadcasting position.created for fixture=${payload.fixtureId}`);
    this.server.emit('position.created', payload.position);
  }

  @OnEvent('position.updated')
  handlePositionUpdated(position: PositionDocument) {
    this.logger.log(`Broadcasting position.updated status=${position.status}`);
    this.server.emit('position.updated', position);
  }
}
