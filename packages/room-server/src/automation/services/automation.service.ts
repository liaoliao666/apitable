/**
 * APITable <https://github.com/apitable/apitable>
 * Copyright (C) 2022 APITable Ltd. <https://apitable.com>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

import {
  AutomationRobotRunner,
  ConfigConstant,
  generateRandomString,
  IActionOutput,
  IActionType,
  IRobot,
  IRobotTask,
  NoticeTemplatesConstant, Strings,
  validateMagicForm,
} from '@apitable/core';
import { Nack, RabbitSubscribe } from '@golevelup/nestjs-rabbitmq';
import { Injectable, Logger } from '@nestjs/common';
import { I18nService } from 'nestjs-i18n';
import fetch from 'node-fetch';
import { NodeService } from 'node/services/node.service';
import { InjectLogger } from 'shared/common';
import { RunHistoryStatusEnum } from 'shared/enums/automation.enum';
import { UnreachableCaseError } from 'shared/errors';
import { CommonException, PermissionException, ServerException } from 'shared/exception';
import { IdWorker } from 'shared/helpers/snowflake';
import { IUserBaseInfo } from 'shared/interfaces';
import {
  automationExchangeName,
  automationRunning,
  automationRunningQueueName,
  notificationQueueExchangeName,
} from 'shared/services/queue/queue.module';
import { QueueSenderBaseService } from 'shared/services/queue/queue.sender.base.service';
import { In } from 'typeorm';
import * as services from '../actions';
import { customActionMap } from '../actions/decorators/automation.action.decorator';
import { IActionResponse } from '../actions/interface/action.response';
import { AutomationActionEntity } from '../entities/automation.action.entity';
import { AutomationRobotEntity } from '../entities/automation.robot.entity';
import { AutomationTriggerEntity } from '../entities/automation.trigger.entity';
import { AutomationActionRepository } from '../repositories/automation.action.repository';
import { AutomationRobotRepository } from '../repositories/automation.robot.repository';
import { AutomationRunHistoryRepository } from '../repositories/automation.run.history.repository';
import { AutomationTriggerRepository } from '../repositories/automation.trigger.repository';
import { RobotRobotService } from './robot.robot.service';

/**
 * handle robot execution scheduling
 * TODO:
 * for now robot is a beta feature, we need refactor it to support more features.
 * permission check is important and need to be done first.
 */
@Injectable()
export class AutomationService {
  robotRunner: AutomationRobotRunner;

  constructor(
    // @ts-ignore
    @InjectLogger() private readonly logger: Logger,
    private readonly automationRobotRepository: AutomationRobotRepository,
    private readonly automationRunHistoryRepository: AutomationRunHistoryRepository,
    private readonly automationActionRepository: AutomationActionRepository,
    private readonly automationTriggerRepository: AutomationTriggerRepository,
    private readonly robotService: RobotRobotService,
    private readonly nodeService: NodeService,
    private readonly queueSenderService: QueueSenderBaseService,
    private readonly i18n: I18nService
  ) {
    this.robotRunner = new AutomationRobotRunner({
      requestActionOutput: this.getActionOutput.bind(this),
      getRobotById: this.getRobotById.bind(this),
      reportResult: this.updateTaskRunHistory.bind(this),
    });
  }

  async recoverRobots(robots: AutomationRobotEntity[], actions: AutomationActionEntity[], triggers: AutomationTriggerEntity[]) {
    const robotIdMap = new Map<string, string>();
    if (robots) {
      robots.forEach((r) => {
        r.id = IdWorker.nextId() + '';
        r.isActive = false;
        const oldId = r.robotId;
        const newId = 'arb' + generateRandomString(15);
        r.robotId = newId;
        robotIdMap.set(oldId, newId);
      });
      await this.automationRobotRepository.createQueryBuilder().insert().values(robots).execute();
    }
    if (actions) {
      actions.forEach((r) => {
        r.id = IdWorker.nextId() + '';
        r.actionId = 'aac' + generateRandomString(15);
        const oldId = r.robotId;
        r.robotId = robotIdMap.get(oldId) || oldId;
      });
      await this.automationActionRepository.createQueryBuilder().insert().values(actions).execute();
    }
    if (triggers) {
      triggers.forEach((r) => {
        r.id = IdWorker.nextId() + '';
        r.triggerId = 'att' + generateRandomString(15);
        const oldId = r.robotId;
        r.robotId = robotIdMap.get(oldId) || oldId;
      });
      await this.automationTriggerRepository.createQueryBuilder().insert().values(triggers).execute();
    }
  }

  async getRobotsByDstId(dstId: string) {
    return await this.automationRobotRepository.find({
      where: {
        resourceId: dstId,
      },
    });
  }

  async getActionByRobotIds(robotIds: string[]) {
    return await this.automationActionRepository.find({
      where: {
        robotId: In(robotIds),
      },
    });
  }

  async getTriggersByRobotIds(robotIds: string[]) {
    return await this.automationTriggerRepository.find({
      where: {
        robotId: In(robotIds),
      },
    });
  }

  async checkCreateRobotPermission(resourceId: string) {
    // TODO: permission check
    const robotCount = await this.automationRobotRepository.getRobotCountByResourceId(resourceId);
    if (robotCount > ConfigConstant.MAX_ROBOT_COUNT_PER_DST) {
      throw new ServerException(CommonException.ROBOT_CREATE_OVER_MAX_COUNT_LIMIT);
    }
  }

  async getRobotById(robotId: string) {
    return await this.robotService.getRobotById(robotId);
  }

  async saveTaskContext(robotTask: IRobotTask, robot: IRobot) {
    const spaceId = await this.getSpaceIdByRobotId(robotTask.robotId);
    const context = this.robotRunner.initRuntimeContext(robotTask, robot);
    const newRunHistory = this.automationRunHistoryRepository.create({
      taskId: robotTask.taskId,
      robotId: robotTask.robotId,
      spaceId,
      status: robotTask.status,
      data: context.context,
    });
    await this.automationRunHistoryRepository.insert(newRunHistory);
  }

  /**
   * update the execution record after the task is completed
   * @param taskId
   * @param success
   * @param data
   */
  async updateTaskRunHistory(taskId: string, success: boolean, data?: any) {
    const status = success ? RunHistoryStatusEnum.SUCCESS : RunHistoryStatusEnum.FAILED;
    if (data) {
      await this.automationRunHistoryRepository.update({ taskId }, { status, data });
    } else {
      await this.automationRunHistoryRepository.update({ taskId }, { status });
    }
    if (!success) {
      await this.sendFailureMessage(taskId);
    }
  }

  async getActionOutput(actionRuntimeInput: any, actionType: IActionType): Promise<IActionOutput> {
    const url = new URL(actionType.baseUrl);
    switch (url.protocol) {
      // SaaS/third-party service
      // https://<serviceBaseURL>/<endpoint>
      case 'http:': // some self-hosted service may use http
      case 'https:': {
        url.pathname = actionType.endpoint;
        const resp = await fetch(url.toString(), {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify(actionRuntimeInput),
        });
        return await this.getOutputResult(resp);
      }
      case 'automation:': {
        // local/official service
        // automation://<serviceSlug>/<endpoint>
        const serviceSlug = url.hostname;
        const endpoint = actionType.endpoint;
        const actionFunc: (input: any) => Promise<IActionResponse<any>> = services[serviceSlug][endpoint];
        const resp = await actionFunc(actionRuntimeInput);
        return {
          success: resp.success,
          data: resp.data as any,
        };
      }
      case 'action:': {
        const connectorKey = url.hostname;
        const connector = customActionMap.get(connectorKey)!;
        const resp = await connector.endpoint(actionRuntimeInput);
        return {
          success: resp.success,
          data: resp.data as any,
        };
      }
      default:
        throw new UnreachableCaseError(actionType.baseUrl as never);
    }
  }

  async handleTask(robotId: string, trigger: { input: any; output: any }) {
    const spaceId = await this.getSpaceIdByRobotId(robotId);
    // there is no billing plan yet, so there is no limit. self-hosted should not limit the call.
    // there limit by billing plan
    // const spaceRobotRunTimes = await this.getRobotRunTimesBySpaceId(spaceId);
    // if (spaceRobotRunTimes >= 100000) {
    //   return;
    // }
    const taskId = IdWorker.nextId().toString(); // TODO: use uuid
    // 1. create run history
    await this.createRunHistory(robotId, taskId, spaceId);
    try {
      // 2. execute the robot
      await this.robotRunner.run({
        robotId,
        triggerInput: trigger.input,
        triggerOutput: trigger.output,
        taskId,
        status: RunHistoryStatusEnum.RUNNING,
      });
    } catch (error) {
      // 3. update run history when failed
      // runtime error should not be saved to database, it should be logged. then we can find the error by taskId.
      await this.updateTaskRunHistory(taskId, false, null);
      this.logger.error(`RobotRuntimeError[${taskId}]`, (error as Error).message);
    }
  }

  @RabbitSubscribe({
    exchange: automationExchangeName,
    routingKey: automationRunning,
    queue: automationRunningQueueName,
  })
  async handleTaskByTaskIdAndTriggerId(message: { taskId: string; triggerId: string }) {
    const { taskId, triggerId } = message;
    this.logger.log('RobotRunning', { ...message });
    try {
      const task: IRobotTask | undefined = await this.automationRunHistoryRepository.selectContextByTaskIdAndTriggerId(taskId, triggerId);
      if (RunHistoryStatusEnum.PENDING != task!.status) {
        return new Nack();
      }
      // update status first to avoid run it again
      await this.automationRunHistoryRepository.updateStatusByTaskId(taskId, RunHistoryStatusEnum.RUNNING);
      // 2. execute the robot
      await this.robotRunner.run(task!);
    } catch (error) {
      // 3. update run history when failed
      // runtime error should not be saved to database, it should be logged. then we can find the error by taskId.
      await this.updateTaskRunHistory(taskId, false);
      // await this.sendFailureMessage(robotId);

      this.logger.error(`RobotRuntimeError[${taskId}]`, (error as Error).message);
    }
    // todo justify
    return new Nack();
  }

  async activeRobot(robotId: string, user: IUserBaseInfo) {
    const errorsByNodeId: any = {};
    try {
      const robot = await this.robotService.getRobotDetailById(robotId);
      const actions = Object.values(robot.actionsById);
      const { trigger, triggerType } = robot as any;
      let isTriggerValid = true;
      if (trigger && triggerType) {
        const triggerInputSchema = triggerType.inputJSONSchema;
        const triggerInput = trigger.input;
        const { hasError, errors, validationError } = validateMagicForm((triggerInputSchema as any).schema, triggerInput);
        if (hasError) {
          isTriggerValid = false;
          this.logger.debug(`trigger is valid: ${isTriggerValid}`);
          errorsByNodeId[trigger.triggerId] = validationError ? [...errors, ...validationError] : errors;
          return {
            ok: false,
            errorsByNodeId,
          };
        }
      }
      this.logger.debug(`trigger is valid: ${isTriggerValid}`);
      const noErrors =
        actions.length > 0 &&
        actions.every((node: any) => {
          const actionType = robot.actionTypesById[node.typeId]!;
          // FIXME: type
          const { hasError, errors, validationError } = validateMagicForm((actionType.inputJSONSchema as any).schema, node.input);
          if (hasError) {
            errorsByNodeId[node.id] = validationError ? [...errors, ...validationError] : errors;
          }
          return !hasError;
        });
      this.logger.debug(`no errors: ${noErrors},${actions}`);
      if (isTriggerValid && noErrors) {
        await this.automationRobotRepository.activeRobot(robotId, user.userId);
        return {
          ok: true,
        };
      }
    } catch (error) {
      this.logger.error('active robot error', error);
      throw new ServerException(CommonException.ROBOT_FORM_CHECK_ERROR);
    }
    return {
      ok: false,
      errorsByNodeId,
    };
  }

  async isResourcesHasRobots(resourceIds: string[]) {
    const hasRobots = await this.automationRobotRepository.isResourcesHasRobots(resourceIds);
    if (!hasRobots) {
      return await this.isResourcesHasTriggers(resourceIds);
    }
    return true;
  }

  async isResourcesHasTriggers(resourceIds: string[]) {
    const triggers = await this.automationTriggerRepository.selectRobotIdAndResourceIdByResourceIds(resourceIds);
    if (triggers.length > 0) {
      const robotIds = new Set(triggers.map(i => i.robotId));
      const number = await this.automationRobotRepository.selectActiveCountByRobotIds(Array.from(robotIds));
      return number > 0;
    }
    return false;
  }

  /**
   * create an execution record before the task is about to run
   * @param robotId
   * @param taskId
   * @param spaceId
   * @param data context
   */
  private async createRunHistory(robotId: string, taskId: string, spaceId: string, data?: any) {
    const newRunHistory = this.automationRunHistoryRepository.create({
      taskId,
      robotId,
      spaceId,
      status: RunHistoryStatusEnum.RUNNING,
      data,
    });
    await this.automationRunHistoryRepository.insert(newRunHistory);
  }

  /**
   * Processes a response object and extracts the relevant output.
   * @param resp The response object to process.
   * @returns An object containing the success flag and the extracted data.
   */
  private async getOutputResult(resp: any) {
    const contentType = resp.headers.get('content-type');
    const success = true;

    if (contentType && contentType.includes('application/json')) {
      // Response is JSON
      const data = await resp.json();
      return { success: !data?.errors, data };
    }
    // Response is not JSON
    const data = { data: await resp.text() };
    return { success, data };
  }

  private async getSpaceIdByRobotId(robotId: string) {
    const resourceId = await this.automationRobotRepository.getResourceIdByRobotId(robotId);
    const rawResult = await this.nodeService.selectSpaceIdByNodeId(resourceId!);
    if (!rawResult?.spaceId) {
      throw new ServerException(PermissionException.NODE_NOT_EXIST);
    }
    return rawResult.spaceId;
  }

  private async sendFailureMessage(taskId: string) {
    const robotId = await this.automationRunHistoryRepository.selectRobotIdByTaskId(taskId);
    if (!robotId) {
      return;
    }
    const robot = await this.automationRobotRepository.selectRobotSimpleInfoByRobotId(robotId);
    if (robot?.props?.failureNotifyEnable) {
      const spaceId = (await this.nodeService.selectSpaceIdByNodeId(robot.resourceId))?.spaceId;
      const message = {
        nodeId: robot.resourceId,
        spaceId: spaceId,
        body: {
          extras: {
            robotId,
            automationName: robot.name || await this.i18n.translate(Strings.robot_unnamed),
            endAt: Date.now(),
          },
        },
        templateId: NoticeTemplatesConstant.workflow_execute_failed_notify,
        toUserId: [robot.createdBy],
      };
      await this.queueSenderService.sendMessage(notificationQueueExchangeName, 'notification.message', message);
    }
  }
}
