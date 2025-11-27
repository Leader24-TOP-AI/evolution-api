/**
 * Health Monitor Router
 *
 * Defines routes for health monitoring API endpoints.
 */

import { RouterBroker } from '@api/abstract/abstract.router';
import { InstanceDto } from '@api/dto/instance.dto';
import { authGuard } from '@api/guards/auth.guard';
import { healthMonitorController } from '@api/server.module';
import { instanceSchema } from '@validate/validate.schema';
import { RequestHandler, Router } from 'express';

import { HttpStatus } from './index.router';

export class HealthMonitorRouter extends RouterBroker {
  constructor(...guards: RequestHandler[]) {
    super();
    this.router
      // GET /health-monitor/dashboard - Complete dashboard data
      .get('/dashboard', authGuard['apikey'], async (req, res) => {
        const response = await healthMonitorController.getDashboard();
        res.status(HttpStatus.OK).json(response);
      })

      // GET /health-monitor/system - System-wide health
      .get('/system', authGuard['apikey'], async (req, res) => {
        const response = await healthMonitorController.getSystemHealth();
        res.status(HttpStatus.OK).json(response);
      })

      // GET /health-monitor/instances - All instances health
      .get('/instances', authGuard['apikey'], async (req, res) => {
        const response = await healthMonitorController.getAllInstancesHealth();
        res.status(HttpStatus.OK).json(response);
      })

      // GET /health-monitor/instance/:instanceName - Single instance health
      .get(this.routerPath('instance'), ...guards, async (req, res) => {
        const response = await this.dataValidate<InstanceDto>({
          request: req,
          schema: instanceSchema,
          ClassRef: InstanceDto,
          execute: (instance) => healthMonitorController.getInstanceHealth(instance),
        });

        res.status(HttpStatus.OK).json(response);
      })

      // GET /health-monitor/events - Recent health events (global)
      .get('/events', authGuard['apikey'], async (req, res) => {
        const response = await healthMonitorController.getRecentEvents();
        res.status(HttpStatus.OK).json(response);
      })

      // GET /health-monitor/events/:instanceName - Events for specific instance
      .get(this.routerPath('events'), ...guards, async (req, res) => {
        const response = await this.dataValidate<InstanceDto>({
          request: req,
          schema: instanceSchema,
          ClassRef: InstanceDto,
          execute: (instance) => healthMonitorController.getInstanceEvents(instance),
        });

        res.status(HttpStatus.OK).json(response);
      })

      // GET /health-monitor/circuit-breakers - All circuit breaker statuses
      .get('/circuit-breakers', authGuard['apikey'], async (req, res) => {
        const response = healthMonitorController.getCircuitBreakerStatus();
        res.status(HttpStatus.OK).json(response);
      })

      // POST /health-monitor/circuit-breaker/reset/:instanceName - Reset specific circuit breaker
      .post(this.routerPath('circuit-breaker/reset'), ...guards, async (req, res) => {
        const response = await this.dataValidate<InstanceDto>({
          request: req,
          schema: instanceSchema,
          ClassRef: InstanceDto,
          execute: (instance) => healthMonitorController.resetCircuitBreaker(instance),
        });

        res.status(HttpStatus.OK).json(response);
      })

      // POST /health-monitor/circuit-breakers/reset-all - Reset all circuit breakers
      .post('/circuit-breakers/reset-all', authGuard['apikey'], async (req, res) => {
        const response = healthMonitorController.resetAllCircuitBreakers();
        res.status(HttpStatus.OK).json(response);
      })

      // POST /health-monitor/cleanup - Cleanup old events
      .post('/cleanup', authGuard['apikey'], async (req, res) => {
        const response = await healthMonitorController.cleanupOldEvents();
        res.status(HttpStatus.OK).json(response);
      });
  }

  public readonly router: Router = Router();
}
